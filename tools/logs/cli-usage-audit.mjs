#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUEST_SCHEMA = "daemon-request-log/v1";
const DEFAULT_SLOW_MS = 5_000;
const DAY_MS = 86_400_000;

export function loadJsonl(files, schema) {
  const rows = [];
  const issues = {
    filesRequested: files.length,
    filesRead: 0,
    unreadableFiles: [],
    malformedJsonLines: 0,
    ignoredLines: 0,
  };
  for (const file of files) {
    let body;
    try {
      body = readFileSync(file, "utf8");
      issues.filesRead += 1;
    } catch (error) {
      issues.unreadableFiles.push({ file, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const line of body.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      if (!line.trimStart().startsWith("{")) {
        issues.ignoredLines += 1;
        continue;
      }
      try {
        const value = JSON.parse(line);
        if (value?.schema !== schema) {
          issues.ignoredLines += 1;
          continue;
        }
        const at = Date.parse(value.at ?? value.atEnd ?? "");
        if (Number.isNaN(at)) {
          issues.ignoredLines += 1;
          continue;
        }
        rows.push({ ...value, atMs: at, sourceFile: file });
      } catch {
        issues.malformedJsonLines += 1;
      }
    }
  }
  const result = rows.sort((left, right) => left.atMs - right.atMs);
  Object.defineProperty(result, "loadIssues", { value: issues, enumerable: false });
  return result;
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
  void options;
  return commands
    .map((command) => {
      const id = command.id ?? command.actionKind ?? command.usage;
      const action = command.actionKind ?? id;
      return {
        id,
        actionKind: action,
        method: command.method ?? null,
        path: command.path?.join(" ") ?? null,
        usage: command.usage ?? null,
        phase: command.phase ?? "unknown",
        commandClass: command.commandClass ?? "unknown",
        testCoverage: "unmeasured",
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function auditCliUsage({
  commands,
  requestRecords,
  nowMs = Date.now(),
  slowMs = DEFAULT_SLOW_MS,
  receipts = [],
  events = [],
  sourceRoot = null,
  logRoot = null,
}) {
  const sorted = [...requestRecords].sort((left, right) => left.atMs - right.atMs);
  const firstObservedAt = sorted[0]?.atMs ?? null;
  const lastObservedAt = sorted.at(-1)?.atMs ?? null;
  const windows = [7, 30].map((days) => buildWindow(days, sorted, nowMs));
  const attribution = attributeRequests(sorted, commands);
  const failures = buildFailureFamilies(sorted, commands, slowMs, receipts, events);
  const slowCalls = summarizeSlowCalls(sorted, slowMs);
  const observedIds = new Set(attribution.observedIds);
  const denominator = commands.map((command) => {
    const counts = attribution.byCommand.get(command.id) ?? { direct: 0, uniqueMethod: 0, shared: 0 };
    const count = counts.direct + counts.uniqueMethod;
    return {
      ...command,
      observedRequests: count,
      directObservedRequests: counts.direct,
      uniqueMethodObservedRequests: counts.uniqueMethod,
      sharedMethodObservedRequests: counts.shared,
      status: count > 0 ? "observed" : counts.shared > 0 ? "unattributed-shared-method" : "unobserved-needs-review",
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
      sourceRoot,
      logRoot,
      requestCount: sorted.length,
      uniqueCommands: observedIds.size,
      sourceAttribution,
      methodAttribution: {
        uniqueMethodRequests: attribution.uniqueMethodRequests,
        sharedMethodRequests: attribution.sharedMethodRequests,
        unattributedMethodRequests: attribution.sharedMethodRequests,
        note: "shared RPC methods are evidence of traffic but cannot be assigned to a command descriptor",
      },
      retentionWindowMs: firstObservedAt === null ? 0 : Math.max(0, lastObservedAt - firstObservedAt),
      retentionWindowDays:
        firstObservedAt === null ? 0 : Math.round(((lastObservedAt - firstObservedAt) / DAY_MS) * 100) / 100,
      rotationGaps: findGaps(sorted),
      logIntegrity: {
        ...(requestRecords.loadIssues ?? {
          filesRequested: 0,
          filesRead: 0,
          unreadableFiles: [],
          malformedJsonLines: 0,
          ignoredLines: 0,
        }),
        complete:
          (requestRecords.loadIssues?.filesRequested ?? 0) > 0 &&
          (requestRecords.loadIssues?.unreadableFiles.length ?? 0) === 0 &&
          (requestRecords.loadIssues?.malformedJsonLines ?? 0) === 0,
      },
    },
    windows,
    denominator,
    failures,
    zeroObservation: denominator
      .filter((row) => row.observedRequests === 0 && row.sharedMethodObservedRequests === 0)
      .map((row) => ({
        id: row.id,
        usage: row.usage,
        testCoverage: row.testCoverage ?? "unmeasured",
        disposition: row.retirementDisposition,
        evidenceLimit: "absence in a short local retention window is not a six-month zero-use conclusion",
      })),
    correlation: {
      receiptOpIds: receipts.length,
      eventOpIds: events.length,
      correlatedFailureFamilies: failures.filter((family) => family.correlatedOpIds > 0).length,
    },
    slowCalls,
  };
}

function attributeRequests(records, commands) {
  const byCommand = new Map();
  const ownersByMethod = new Map();
  for (const command of commands) {
    const identities = new Set([command.id, command.actionKind].filter(Boolean));
    for (const identity of identities) {
      const counts = byCommand.get(identity) ?? { direct: 0, uniqueMethod: 0, shared: 0 };
      byCommand.set(identity, counts);
    }
    if (command.method) {
      const owners = ownersByMethod.get(command.method) ?? [];
      owners.push(command);
      ownersByMethod.set(command.method, owners);
    }
  }
  const observedIds = new Set();
  let uniqueMethodRequests = 0;
  let sharedMethodRequests = 0;
  for (const record of records) {
    const directMatches = commands.filter((command) =>
      [command.id, command.actionKind].filter(Boolean).includes(record.command),
    );
    if (directMatches.length) {
      for (const command of directMatches) {
        const counts = byCommand.get(command.id) ?? { direct: 0, uniqueMethod: 0, shared: 0 };
        counts.direct += 1;
        byCommand.set(command.id, counts);
        observedIds.add(command.id);
      }
      continue;
    }
    const owners = record.method ? (ownersByMethod.get(record.method) ?? []) : [];
    if (owners.length === 1) {
      const command = owners[0];
      const counts = byCommand.get(command.id) ?? { direct: 0, uniqueMethod: 0, shared: 0 };
      counts.uniqueMethod += 1;
      byCommand.set(command.id, counts);
      observedIds.add(command.id);
      uniqueMethodRequests += 1;
    } else if (owners.length > 1) {
      sharedMethodRequests += 1;
      for (const command of owners) {
        const counts = byCommand.get(command.id) ?? { direct: 0, uniqueMethod: 0, shared: 0 };
        counts.shared += 1;
        byCommand.set(command.id, counts);
      }
    }
  }
  return { byCommand, observedIds, uniqueMethodRequests, sharedMethodRequests };
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
        uniqueIntentCount: 0,
        correlatedOpIds: new Set(),
        duplicateRequestsSuppressed: 0,
        maxDurationMs: 0,
        slowRequestCount: 0,
      };
      groups.set(key, family);
    }
    family.requestCount += 1;
    if (record.opId) {
      if (family.uniqueOpIds.has(record.opId)) family.duplicateRequestsSuppressed += 1;
      else family.uniqueIntentCount += 1;
      family.uniqueOpIds.add(record.opId);
      if (receiptIds.has(record.opId)) family.correlatedOpIds.add(record.opId);
    } else {
      family.uniqueIntentCount += 1;
    }
    family.maxDurationMs = Math.max(family.maxDurationMs, Number(record.durationMs) || 0);
    if ((Number(record.durationMs) || 0) >= slowMs) family.slowRequestCount += 1;
  }
  return [...groups.values()]
    .map((family) => ({
      ...family,
      uniqueOpIds: family.uniqueOpIds.size,
      uniqueIntentCount: family.uniqueIntentCount,
      correlatedOpIds: family.correlatedOpIds.size,
      duplicateRequestsSuppressed: family.duplicateRequestsSuppressed,
      category: "needs-triage",
    }))
    .sort((left, right) => right.requestCount - left.requestCount || left.key.localeCompare(right.key));
}

function summarizeSlowCalls(records, slowMs) {
  const slow = records.filter((record) => (Number(record.durationMs) || 0) >= slowMs);
  const durations = slow.map((record) => Number(record.durationMs) || 0);
  return {
    thresholdMs: slowMs,
    requestCount: slow.length,
    successfulRequestCount: slow.filter((record) => record.ok === true).length,
    failedRequestCount: slow.filter((record) => record.ok !== true).length,
    maxDurationMs: durations.length ? Math.max(...durations) : 0,
    averageDurationMs: durations.length
      ? Math.round((durations.reduce((sum, duration) => sum + duration, 0) / durations.length) * 100) / 100
      : 0,
    commands: [...new Set(slow.map((record) => record.command ?? "<unknown>"))].sort(),
  };
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
  const requestFiles = options.files.length ? options.files : discoverRequestLogFiles(rootDir);
  const receipts = collectOpIds(options.receiptFiles);
  const events = collectOpIds(options.eventFiles);
  const requestRecords = loadJsonl(requestFiles, REQUEST_SCHEMA);
  if (requestRecords.loadIssues?.unreadableFiles.length) {
    const files = requestRecords.loadIssues.unreadableFiles.map(({ file }) => file).join(", ");
    throw new Error(`request log input unreadable: ${files}`);
  }
  const report = auditCliUsage({
    commands: buildCommandDenominator(commands),
    requestRecords,
    nowMs: options.now ? Date.parse(options.now) : Date.now(),
    slowMs: options.slowMs,
    receipts,
    events,
    sourceRoot: rootDir,
    logRoot: requestFiles.length ? path.dirname(path.resolve(requestFiles[0])) : null,
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
  if (options.now !== null && Number.isNaN(Date.parse(options.now))) throw new Error("--now must be an ISO date");
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
