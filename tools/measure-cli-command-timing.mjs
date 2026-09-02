#!/usr/bin/env node
// Measures the end-to-end and phase-resolved cost of a fixed set of `ha` commands against the
// compiled CLI's own `--help` no-op, and emits a cli-command-timing/v1 document.
//
// Every number here comes from the product path: a real `ha init` builds the fixture repository
// and auto-starts a real resident daemon, and every sample is a real CLI process running a real
// command against it (dec_9B75595FC45E01DDFD0938FE95/CH1). The CLI reports its own phases through
// HA_CLI_TIMING; this file only spawns, groups, and joins.
//
// The reported limit quantity is a ratio, never a millisecond. Each round divides the median of a
// command's totalMs by the median of the no-op's totalMs measured in the same round with the two
// arms alternating, so host speed and load cancel inside the pair. That is the shape
// packages/cli/test/daemon-multi-repo-lifecycle-cli-latency.test.ts already carries in
// enforcement, where the same bare-Node denominator read 14.472x on Linux and 20.843x on Windows.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./gates/git.mjs";

const PROBE_TASK = "task-cli-timing-probe";
export const NOOP_ID = "compiled-cli-help-noop";

// The measured surface: one no-op denominator, three reads at different projection widths, one
// workspace-wide read, and one durable write. `workspace summary` from the task brief does not
// exist on this CLI (there is no workspace domain); `agenda` is the workspace-wide read that does.
export const MEASURED_COMMANDS = Object.freeze([
  { id: NOOP_ID, argv: ["--help"], daemonMethods: [] },
  { id: "task-list", argv: ["--json", "task", "list"], daemonMethods: ["repo.task.read"] },
  { id: "task-show", argv: ["--json", "task", "show", PROBE_TASK], daemonMethods: ["repo.task.read"] },
  { id: "doc-status", argv: ["--json", "doc", "status"], daemonMethods: ["repo.task.read"] },
  { id: "agenda-read", argv: ["--json", "agenda"], daemonMethods: ["repo.agenda.read"] },
  { id: "fact-record", argv: null, daemonMethods: ["repo.task.run"] },
]);

export function factRecordArgv(sampleId) {
  return [
    "--json",
    "fact",
    "record",
    PROBE_TASK,
    "--statement",
    `cli command timing sample ${sampleId}`,
    "--source",
    "tools/measure-cli-command-timing.mjs",
  ];
}

export function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered.length === 0 ? 0 : ordered[Math.floor(ordered.length / 2)];
}

export function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)];
}

export function summarize(values) {
  return {
    samples: values.length,
    p50: round(median(values)),
    p95: round(percentile(values, 0.95)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

// A CLI record claims a connection-log line when the method matches and the daemon received the
// frame inside the window the CLI itself observed for that round trip. Two concurrent clients
// cannot collide here because the measurer runs one CLI process at a time.
//
// A claimed line is consumed. Without that, an invocation making three round trips of the same
// method inside one window matched the same log line three times and reported one handler cost
// tripled instead of three real ones -- which is exactly the shape a duplicated-read regression
// has, so the detector would have agreed with the defect it is supposed to distinguish.
export function joinDaemonHandlerMs(record, daemonRequests, claimed = new Set()) {
  let handlerMs = 0,
    matched = 0;
  for (const roundTrip of record.daemonRequests ?? []) {
    const index = daemonRequests.findIndex(
      (row, at) =>
        !claimed.has(at) &&
        row.method === roundTrip.method &&
        row.frameReceivedAtMs >= roundTrip.startedAtEpochMs - 2 &&
        row.frameReceivedAtMs <= roundTrip.endedAtEpochMs + 2,
    );
    if (index < 0) continue;
    claimed.add(index);
    handlerMs += daemonRequests[index].serviceMs;
    matched += 1;
  }
  return { handlerMs, matched, expected: (record.daemonRequests ?? []).length };
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function parseArgs(argv) {
  const options = { out: null, rounds: 5, warmupRounds: 2, samplesPerRound: 3, rootDir: null, keepFixture: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--out") options.out = requireValue(argv, ++index, flag);
    else if (flag === "--root") options.rootDir = path.resolve(requireValue(argv, ++index, flag));
    else if (flag === "--rounds") options.rounds = requireInteger(argv, ++index, flag);
    else if (flag === "--warmup") options.warmupRounds = requireInteger(argv, ++index, flag);
    else if (flag === "--samples") options.samplesPerRound = requireInteger(argv, ++index, flag);
    else if (flag === "--keep-fixture") options.keepFixture = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!options.out) throw new Error("--out <path> is required");
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function requireInteger(argv, index, flag) {
  const value = Number(requireValue(argv, index, flag));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} requires a non-negative integer`);
  return value;
}

function makeFixture(rootDir, sha) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-cli-timing-")),
    repo = path.join(fixtureRoot, "repo"),
    userRoot = path.join(fixtureRoot, "user"),
    home = path.join(fixtureRoot, "home"),
    cli = path.join(rootDir, "packages/cli/dist/cli/src/index.js");
  if (!existsSync(cli))
    throw new Error(`compiled CLI is missing at ${cli}; run npm run build -w @harness-anything/cli first`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "--quiet"], { stdio: "ignore" });
  return { fixtureRoot, repo, userRoot, home, cli, sha };
}

// An inherited HARNESS_DAEMON_* pointing at the developer's own resident daemon silently retargets
// every sample at the wrong workspace -- the first attempt here failed with "workspace is not
// registered" for exactly that reason. The fixture supplies its own, and inherits none.
const SCOPED_ENVIRONMENT_KEYS = Object.freeze([
  "HARNESS_ACTOR",
  "HARNESS_DAEMON_ENDPOINT",
  "HARNESS_DAEMON_ID",
  "HARNESS_DAEMON_REPO_ID",
  "HARNESS_DAEMON_USER_ROOT",
  "HA_CLI_TIMING",
  "HA_CLI_TIMING_FILE",
  "HA_CLI_TIMING_SHA",
]);

function invoke(fixture, argv, { timing = true } = {}) {
  const baseEnv = { ...process.env };
  for (const key of SCOPED_ENVIRONMENT_KEYS) delete baseEnv[key];
  const startedAt = performance.now(),
    result = spawnSync(process.execPath, [fixture.cli, "--root", fixture.repo, ...argv], {
      encoding: "utf8",
      env: {
        ...baseEnv,
        HOME: fixture.home,
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
        ...(timing ? { HA_CLI_TIMING: "1", HA_CLI_TIMING_SHA: fixture.sha } : {}),
      },
    }),
    wallMs = performance.now() - startedAt;
  return { ...result, wallMs, record: timing ? lastTimingRecord(result.stderr ?? "") : null };
}

// The record is the last ha-cli-timing/v2 line on stderr, so daemon autostart progress lines and
// warming notices on the same stream do not have to be suppressed to be tolerated.
export function lastTimingRecord(stderr) {
  for (const line of stderr.split("\n").reverse()) {
    if (!line.includes('"ha-cli-timing/v2"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.schema === "ha-cli-timing/v2") return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function sample(fixture, command, sampleId) {
  const argv = command.argv ?? factRecordArgv(sampleId),
    result = invoke(fixture, argv);
  if (result.status !== 0) throw new Error(`${command.id} exited ${result.status}: ${failureDetail(result)}`);
  if (!result.record)
    throw new Error(
      `${command.id} produced no ha-cli-timing/v2 record; the measured CLI is not instrumented ` +
        `(negative control: this is the expected failure on a pre-instrumentation revision)`,
    );
  return result;
}

function measure(fixture, options) {
  const measured = new Map(MEASURED_COMMANDS.map((command) => [command.id, []])),
    roundRatios = new Map(MEASURED_COMMANDS.map((command) => [command.id, []])),
    load = [],
    totalRounds = options.warmupRounds + options.rounds;
  for (let round = 0; round < totalRounds; round += 1) {
    const counted = round >= options.warmupRounds,
      roundTotals = new Map(MEASURED_COMMANDS.map((command) => [command.id, []]));
    for (const command of MEASURED_COMMANDS) {
      if (command.id === NOOP_ID) continue;
      for (let index = 0; index < options.samplesPerRound; index += 1) {
        const sampleId = `${round}-${index}`,
          // Alternating arm order inside each round keeps a scheduler pause from landing on the
          // same arm every time; medians then absorb it into one sample, not the verdict.
          first = (round + index) % 2 === 0,
          run = () => record(command, sample(fixture, command, sampleId)),
          runNoop = () => record(MEASURED_COMMANDS[0], sample(fixture, MEASURED_COMMANDS[0], sampleId));
        if (first) {
          run();
          runNoop();
        } else {
          runNoop();
          run();
        }
      }
    }
    if (counted) {
      const noopMedian = median(roundTotals.get(NOOP_ID));
      load.push(round4(loadavg()[0] / availableParallelism()));
      for (const command of MEASURED_COMMANDS) {
        if (command.id === NOOP_ID || noopMedian === 0) continue;
        roundRatios.get(command.id).push(median(roundTotals.get(command.id)) / noopMedian);
      }
    }
    process.stdout.write(`[measure] round ${round + 1}/${totalRounds}${counted ? "" : " (warmup)"}\n`);

    function record(command, result) {
      if (!counted) return;
      measured.get(command.id).push(result);
      roundTotals.get(command.id).push(result.record.totalMs);
    }
  }
  return { measured, roundRatios, load };
}

function failureDetail(result) {
  return `${(result.stdout ?? "").slice(0, 600)}${(result.stderr ?? "").slice(0, 600)}`.trim() || "no output";
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export function readDaemonRequests(userRoot) {
  const logDir = path.join(userRoot, "logs");
  if (!existsSync(logDir)) return [];
  const rows = [];
  for (const name of readdirSync(logDir)) {
    if (!name.startsWith("daemon-default-conn-") || !name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(path.join(logDir, name), "utf8").split("\n")) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.event !== "request" || typeof row.method !== "string") continue;
      rows.push({
        method: row.method,
        frameReceivedAtMs: Date.parse(row.frameReceivedAt ?? row.at),
        serviceMs: Number(row.serviceMs ?? row.durationMs ?? 0),
      });
    }
  }
  return rows;
}

function summarizeCommand(command, results, ratios, daemonRequests, claimed) {
  const totals = results.map((result) => result.record.totalMs),
    phases = ["spawn", "parse", "dispatch", "daemonRoundTrip", "render"],
    joins = results.map((result) => joinDaemonHandlerMs(result.record, daemonRequests, claimed)),
    handlerSamples = joins.filter((join) => join.matched === join.expected).map((join) => join.handlerMs),
    localSamples = results
      .map((result, index) => ({ total: result.record.totalMs, join: joins[index] }))
      .filter((entry) => entry.join.matched === entry.join.expected)
      .map((entry) => Math.max(0, entry.total - entry.join.handlerMs));
  return {
    argv: command.argv ?? factRecordArgv("<sample>"),
    daemonMethods: command.daemonMethods,
    totalMs: summarize(totals),
    wallMs: summarize(results.map((result) => result.wallMs)),
    phases: Object.fromEntries(phases.map((phase) => [phase, summarize(results.map((r) => r.record.phases[phase]))])),
    daemonRoundTrips: summarize(results.map((result) => (result.record.daemonRequests ?? []).length)),
    daemonHandlerMs: handlerSamples.length > 0 ? summarize(handlerSamples) : null,
    localMs: localSamples.length > 0 ? summarize(localSamples) : null,
    handlerJoin: { matched: joins.filter((join) => join.matched === join.expected).length, samples: joins.length },
    ratio: ratios.length > 0 ? { ...summarize(ratios), rounds: ratios.map(round) } : null,
  };
}

export function buildMeasurement({ sha, sourceStatus, options, measured, roundRatios, load, daemonRequests }) {
  const claimed = new Set();
  return {
    schema: "cli-command-timing/v1",
    measuredAt: new Date().toISOString(),
    basisRevision: sha,
    sourceState: { dirty: sourceStatus.length > 0, status: sourceStatus },
    runner: {
      platform: process.platform,
      arch: process.arch,
      parallelism: availableParallelism(),
      node: process.version,
      load1PerParallelism: load,
    },
    measurement: {
      shape: "compiled CLI subprocess per sample against one resident daemon created by a real ha init",
      baseline: NOOP_ID,
      warmupRounds: options.warmupRounds,
      rounds: options.rounds,
      samplesPerRound: options.samplesPerRound,
      totalMs: "ha-cli-timing/v2 totalMs: process start through main() return, measured in the CLI",
      ratio: `paired-round median(command totalMs) / median(${NOOP_ID} totalMs)`,
      daemonHandlerMs: "daemon connection-log serviceMs for the round trips this invocation made",
      localMs: "totalMs minus daemonHandlerMs: the part of the invocation the CLI process owns",
    },
    commands: Object.fromEntries(
      MEASURED_COMMANDS.map((command) => [
        command.id,
        summarizeCommand(command, measured.get(command.id), roundRatios.get(command.id) ?? [], daemonRequests, claimed),
      ]),
    ),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv),
    rootDir = options.rootDir ?? repoRoot(),
    sha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceStatus = execFileSync("git", ["-C", rootDir, "status", "--porcelain"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean),
    fixture = makeFixture(rootDir, sha);
  try {
    const initialized = invoke(
      fixture,
      ["--json", "init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"],
      { timing: false },
    );
    if (initialized.status !== 0) throw new Error(`fixture init failed: ${failureDetail(initialized)}`);
    const created = invoke(
      fixture,
      ["--json", "task", "create", "--id", PROBE_TASK, "--admin", "--title", "CLI command timing probe"],
      { timing: false },
    );
    if (created.status !== 0) throw new Error(`probe task create failed: ${failureDetail(created)}`);
    const { measured, roundRatios, load } = measure(fixture, options);
    // The daemon appends its connection log off the reply path, so the last lines are still in
    // flight when the final CLI process exits. Settling before reading is why the join is a real
    // pairing rather than a silent zero.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const measurement = buildMeasurement({
      sha,
      sourceStatus,
      options,
      measured,
      roundRatios,
      load,
      daemonRequests: readDaemonRequests(fixture.userRoot),
    });
    const outPath = path.resolve(rootDir, options.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
    for (const [id, row] of Object.entries(measurement.commands))
      process.stdout.write(
        `${id}: total p50=${row.totalMs.p50}ms p95=${row.totalMs.p95}ms ratio=${row.ratio ? `${row.ratio.p50}x` : "baseline"} ` +
          `daemon=${row.daemonHandlerMs ? `${row.daemonHandlerMs.p50}ms` : "n/a"} local=${row.localMs ? `${row.localMs.p50}ms` : "n/a"}\n`,
      );
    process.stdout.write(`measurement=${outPath}\n`);
    return 0;
  } finally {
    invoke(fixture, ["--json", "daemon", "stop"], { timing: false });
    if (!options.keepFixture) rmSync(fixture.fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
    else process.stdout.write(`fixture=${fixture.fixtureRoot}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = await main();
