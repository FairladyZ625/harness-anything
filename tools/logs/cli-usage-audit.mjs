#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUEST_SCHEMA = "daemon-request-log/v1";
const DEFAULT_SLOW_MS = 5_000;
const DAY_MS = 86_400_000;

export function loadJsonl(files, schema) {
  const rows = [];
  for (const file of files) {
    let body;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of body.split(/\r?\n/u)) {
      if (!line.startsWith("{")) continue;
      try {
        const value = JSON.parse(line);
        if (value?.schema !== schema) continue;
        const at = Date.parse(value.at ?? value.atEnd ?? "");
        if (!Number.isNaN(at)) rows.push({ ...value, atMs: at, sourceFile: file });
      } catch {
        /* malformed historical lines are not evidence */
      }
    }
  }
  return rows.sort((left, right) => left.atMs - right.atMs);
}

export function discoverRequestLogFiles(repoRoot) {
  const directory = path.join(repoRoot, ".harness", "requests");
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^requests\.jsonl(?:\.\d+)?$/u.test(name))
    .sort((left, right) => generation(right) - generation(left))
    .map((name) => path.join(directory, name));
}

function generation(name) {
  return name === "requests.jsonl" ? 0 : Number(name.slice("requests.jsonl.".length));
}

export function buildCommandDenominator(commands, options = {}) {
  const testFiles = options.testFiles ?? [];
  const sourceFiles = options.sourceFiles ?? [];
  return commands
    .map((command) => {
      const action = command.actionKind ?? command.id;
      const tokens = [command.id, action, command.method, ...(command.path ?? []), command.usage].filter(Boolean);
      const testReferences = countReferences(testFiles, tokens);
      const productionReferences = countReferences(sourceFiles, tokens);
      return {
        id: command.id,
        actionKind: action,
        method: command.method ?? null,
        path: command.path?.join(" ") ?? null,
        usage: command.usage ?? null,
        phase: command.phase ?? "unknown",
        commandClass: command.commandClass ?? "unknown",
        testReferences,
        productionReferences,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function countReferences(files, tokens) {
  let count = 0;
  for (const file of files) {
    let body;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (tokens.some((token) => token && body.includes(String(token)))) count += 1;
  }
  return count;
}

export function auditCliUsage({
  commands,
  requestRecords,
  nowMs = Date.now(),
  slowMs = DEFAULT_SLOW_MS,
  receipts = [],
  events = [],
}) {
  const sorted = [...requestRecords].sort((left, right) => left.atMs - right.atMs);
  const firstObservedAt = sorted[0]?.atMs ?? null;
  const lastObservedAt = sorted.at(-1)?.atMs ?? null;
  const windows = [7, 30].map((days) => buildWindow(days, sorted, nowMs));
  const usageByCommand = new Map();
  for (const record of sorted) {
    const command = record.command ?? "<unknown>";
    usageByCommand.set(command, (usageByCommand.get(command) ?? 0) + 1);
  }
  const failures = buildFailureFamilies(sorted, commands, slowMs, receipts, events);
  const observedIds = new Set([...usageByCommand.keys()]);
  const denominator = commands.map((command) => {
    const count = usageByCommand.get(command.id) ?? usageByCommand.get(command.actionKind) ?? 0;
    return {
      ...command,
      observedRequests: count,
      status:
        count > 0
          ? "observed"
          : command.testReferences > 0
            ? "unobserved-tested"
            : "unobserved-no-usage-or-test-evidence",
      retirementDisposition: count > 0 ? "retain-observed" : "needs-human-review",
    };
  });
  const sourceAttribution = {
    cli: 0,
    gui: 0,
    unknown: sorted.length,
    note: "daemon-request-log/v1 has no client-source field; request counts are not CLI-only",
  };
  return {
    schema: "cli-usage-audit/v1",
    generatedAt: new Date(nowMs).toISOString(),
    observation: {
      firstObservedAt: iso(firstObservedAt),
      lastObservedAt: iso(lastObservedAt),
      requestFiles: [...new Set(sorted.map((row) => row.sourceFile))],
      requestCount: sorted.length,
      uniqueCommands: observedIds.size,
      sourceAttribution,
      retentionWindowMs: firstObservedAt === null ? 0 : Math.max(0, lastObservedAt - firstObservedAt),
      retentionWindowDays:
        firstObservedAt === null ? 0 : Math.round(((lastObservedAt - firstObservedAt) / DAY_MS) * 100) / 100,
      rotationGaps: findGaps(sorted),
    },
    windows,
    denominator,
    failures,
    zeroObservation: denominator
      .filter((row) => row.observedRequests === 0)
      .map((row) => ({
        id: row.id,
        usage: row.usage,
        testReferences: row.testReferences,
        disposition: row.retirementDisposition,
        evidenceLimit: "absence in a short local retention window is not a six-month zero-use conclusion",
      })),
    correlation: {
      receiptOpIds: receipts.length,
      eventOpIds: events.length,
      correlatedFailureFamilies: failures.filter((family) => family.correlatedOpIds > 0).length,
    },
  };
}

function buildWindow(days, records, nowMs) {
  const since = nowMs - days * DAY_MS;
  const rows = records.filter((record) => record.atMs >= since && record.atMs <= nowMs);
  return {
    days,
    since: new Date(since).toISOString(),
    until: new Date(nowMs).toISOString(),
    requestCount: rows.length,
    uniqueCommands: new Set(rows.map((row) => row.command ?? "<unknown>")).size,
    firstObservedAt: iso(rows[0]?.atMs ?? null),
    lastObservedAt: iso(rows.at(-1)?.atMs ?? null),
  };
}

function buildFailureFamilies(records, commands, slowMs, receipts, events) {
  const descriptors = new Map(commands.map((command) => [command.id, command]));
  const receiptIds = new Set([...receipts, ...events]);
  const groups = new Map();
  for (const record of records) {
    if (record.ok === true) continue;
    const descriptor = descriptors.get(record.command);
    const code = record.code ?? "<none>";
    const phase = descriptor?.phase ?? "unknown";
    const key = `${code}|${phase}|${record.command ?? "<unknown>"}`;
    let family = groups.get(key);
    if (!family) {
      family = {
        key,
        code,
        phase,
        command: record.command ?? "<unknown>",
        requestCount: 0,
        uniqueOpIds: new Set(),
        correlatedOpIds: new Set(),
        maxDurationMs: 0,
      };
      groups.set(key, family);
    }
    family.requestCount += 1;
    if (record.opId) {
      family.uniqueOpIds.add(record.opId);
      if (receiptIds.has(record.opId)) family.correlatedOpIds.add(record.opId);
    }
    family.maxDurationMs = Math.max(family.maxDurationMs, Number(record.durationMs) || 0);
  }
  return [...groups.values()]
    .map((family) => ({
      ...family,
      uniqueOpIds: family.uniqueOpIds.size,
      correlatedOpIds: family.correlatedOpIds.size,
      duplicateRequestsSuppressed: Math.max(0, family.requestCount - family.uniqueOpIds.size),
      category: classifyFailure(family.code, family.maxDurationMs, slowMs),
    }))
    .sort((left, right) => right.requestCount - left.requestCount || left.key.localeCompare(right.key));
}

function classifyFailure(code, durationMs, slowMs) {
  const lower = code.toLowerCase();
  if (durationMs >= slowMs || /timeout|timed_out|deadline/u.test(lower)) return "slow-call-or-timeout";
  if (/invalid|unknown|unsupported|missing|duplicate|malformed/u.test(lower)) return "invalid-suggestion";
  if (/internal|store|publication|unexpected|panic|corrupt/u.test(lower)) return "product-error";
  return "expected-rejection";
}

function findGaps(records) {
  const gaps = [];
  for (let index = 1; index < records.length; index += 1) {
    const durationMs = records[index].atMs - records[index - 1].atMs;
    if (durationMs > DAY_MS)
      gaps.push({
        from: iso(records[index - 1].atMs),
        to: iso(records[index].atMs),
        durationMs,
        kind: "possible-retention-or-no-usage-gap",
      });
  }
  return gaps;
}

function iso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function walkFiles(root, predicate) {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return predicate(root) ? [root] : [];
  if (!stat.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(root, entry.name);
      return entry.isDirectory() ? walkFiles(target, predicate) : entry.isFile() && predicate(target) ? [target] : [];
    })
    .sort();
}

function collectOpIds(files) {
  const ids = new Set();
  for (const file of files) {
    let body;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      collect(JSON.parse(body), ids);
      continue;
    } catch {
      /* receipts/events are also commonly JSONL */
    }
    for (const line of body.split(/\r?\n/u).filter((entry) => entry.startsWith("{"))) {
      try {
        collect(JSON.parse(line), ids);
      } catch {
        /* malformed lines do not count */
      }
    }
  }
  return [...ids];
}

function collect(value, ids) {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, ids);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "opId" || key === "operationId") && typeof child === "string") ids.add(child);
    collect(child, ids);
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const rootDir = path.resolve(options.root);
  const commandModule = await import(
    `${pathToFileURL(path.join(rootDir, "packages/daemon/src/protocol/daemon-protocol-commands.ts"))}?audit=1`
  );
  const cliModule = await import(
    `${pathToFileURL(path.join(rootDir, "packages/cli/src/cli/thin-command-help.ts")).href}?audit=1`
  );
  const commands = [...commandModule.thinCliCommands, ...cliModule.clientLocalCommands];
  const testFiles = walkFiles(path.join(rootDir, "packages"), (file) => /\.(?:test|spec)\.(?:mjs|js|ts)$/u.test(file));
  const sourceFiles = walkFiles(
    path.join(rootDir, "packages"),
    (file) =>
      /\.(?:mjs|js|ts)$/u.test(file) && !/(?:test|spec)\./u.test(file) && !file.endsWith("daemon-protocol-commands.ts"),
  );
  const requestFiles = options.files.length ? options.files : discoverRequestLogFiles(rootDir);
  const receipts = collectOpIds(options.receiptFiles);
  const events = collectOpIds(options.eventFiles);
  const report = auditCliUsage({
    commands: buildCommandDenominator(commands, { testFiles, sourceFiles }),
    requestRecords: loadJsonl(requestFiles, REQUEST_SCHEMA),
    nowMs: options.now ? Date.parse(options.now) : Date.now(),
    slowMs: options.slowMs,
    receipts,
    events,
  });
  const output = JSON.stringify(report, null, 2) + "\n";
  if (options.out) writeFileSync(path.resolve(options.out), output, "utf8");
  else process.stdout.write(output);
  return 0;
}

function parseArgs(argv) {
  const options = {
    root: ".",
    files: [],
    receiptFiles: [],
    eventFiles: [],
    slowMs: DEFAULT_SLOW_MS,
    out: null,
    now: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index],
      value = argv[index + 1];
    if (flag === "--root") {
      options.root = requireValue(value, flag);
      index += 1;
    } else if (flag === "--file") {
      options.files.push(requireValue(value, flag));
      index += 1;
    } else if (flag === "--receipt-file") {
      options.receiptFiles.push(requireValue(value, flag));
      index += 1;
    } else if (flag === "--event-file") {
      options.eventFiles.push(requireValue(value, flag));
      index += 1;
    } else if (flag === "--slow-ms") {
      options.slowMs = Number(requireValue(value, flag));
      index += 1;
    } else if (flag === "--now") {
      options.now = requireValue(value, flag);
      index += 1;
    } else if (flag === "--out") {
      options.out = requireValue(value, flag);
      index += 1;
    } else if (flag === "--help" || flag === "-h") return { ...options, help: true };
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!Number.isFinite(options.slowMs) || options.slowMs <= 0) throw new Error("--slow-ms must be positive");
  return options;
}

function requireValue(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
function usage() {
  return "usage: node tools/logs/cli-usage-audit.mjs [--root <repo>] [--file <requests.jsonl>]... [--receipt-file <json>]... [--event-file <json>]... [--now <ISO>] [--slow-ms 5000] [--out <report.json>]";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
