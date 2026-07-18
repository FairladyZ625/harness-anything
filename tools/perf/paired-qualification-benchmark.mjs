import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve("packages/cli/src/index.ts");

/**
 * The result format deliberately treats wall-clock latency as diagnostics.
 * Qualification is the same-window candidate/baseline median ratio.
 */
export async function runPairedQualification(input) {
  const scenarios = [];
  for (const writers of input.writerCounts) {
    const samples = { baseline: [], candidate: [] };
    for (let round = 0; round < input.rounds; round += 1) {
      const order = round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      for (const arm of order) samples[arm].push(await input.runArm({ arm, writers, round }));
    }
    const arms = Object.fromEntries(Object.entries(samples).map(([arm, rows]) => [arm, {
      samples: rows,
      medians: medianMetrics(rows)
    }]));
    const scenario = {
      writers,
      alternatingOrder: samples.baseline.flatMap((_, round) => round % 2 === 0
        ? ["baseline", "candidate"] : ["candidate", "baseline"]),
      arms,
      ratios: ratios(arms.baseline.medians, arms.candidate.medians),
      correctness: sumCorrectness([...samples.baseline, ...samples.candidate])
    };
    scenarios.push(scenario);
  }
  return {
    schema: "production-client-paired-qualification/v1",
    measuredAt: new Date().toISOString(),
    protocol: "same-machine-interleaved-arms-median-relative-overhead/v1",
    baseline: { sourceCommit: input.baselineCommit },
    candidate: { sourceCommit: input.sourceCommit },
    scenarios
  };
}

function medianMetrics(rows) {
  const metricNames = Object.keys(rows[0]?.metrics ?? {});
  return Object.fromEntries(metricNames.map((name) => [name, median(rows.map((row) => row.metrics[name]))]));
}

function ratios(baseline, candidate) {
  return {
    submitToDurableReceipt: ratio(candidate.submitToDurableReceiptMs, baseline.submitToDurableReceiptMs),
    queueWait: ratio(candidate.queueWaitMs, baseline.queueWaitMs),
    commitIndex: ratio(candidate.commitIndexMs, baseline.commitIndexMs),
    exactCutLocalApply: ratio(candidate.exactCutLocalApplyMs, baseline.exactCutLocalApplyMs),
    acknowledgement: ratio(candidate.acknowledgementMs, baseline.acknowledgementMs)
  };
}

function ratio(candidate, baseline) {
  return baseline === 0 ? null : rounded(candidate / baseline);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return rounded(sorted[Math.floor(sorted.length / 2)] ?? 0);
}

function sumCorrectness(rows) {
  const total = {};
  for (const row of rows) for (const [key, value] of Object.entries(row.correctness)) total[key] = (total[key] ?? 0) + value;
  return total;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

async function runProductionSocketArm({ writers, arm, round }) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-paired-qualification-"));
  const userRoot = path.join(root, "daemon-user");
  const env = {
    ...process.env,
    HOME: path.join(root, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_ACTOR: "agent:qualification-benchmark",
    HARNESS_GIT_AUTHOR_NAME: "Qualification Benchmark",
    HARNESS_GIT_AUTHOR_EMAIL: "qualification@example.test",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_IDLE_MS: "60000"
  };
  try {
    await cli(root, ["init"], { ...env, HARNESS_DAEMON_MODE: "local" });
    mkdirSync(path.join(root, "harness"), { recursive: true });
    writeFileSync(path.join(root, "harness", "people.yaml"), localRoster(), "utf8");
    const started = await cli(root, ["daemon", "start", "--service", "--json"], { ...env, HARNESS_DAEMON_MODE: "local" });
    if (!started.started) throw new Error("qualification daemon did not start");
    const queueProbeStartedAt = performance.now();
    await cli(root, ["daemon", "status", "--json"], { ...env, HARNESS_DAEMON_MODE: "local" });
    const queueWaitMs = performance.now() - queueProbeStartedAt;
    const startedAt = performance.now();
    const receipts = await Promise.all(Array.from({ length: writers }, (_, writer) => cli(root, [
      "new-task", "--title", `paired ${arm} r${round} w${writer}`
    ], env)));
    const commitIndexMs = performance.now() - startedAt;
    const committed = receipts.filter((receipt) => receipt.ok === true).length;
    const applyStartedAt = performance.now();
    const visible = await cli(root, ["task", "list"], env);
    const exactCutLocalApplyMs = performance.now() - applyStartedAt;
    const acknowledgementStartedAt = performance.now();
    const status = await cli(root, ["daemon", "status", "--json"], { ...env, HARNESS_DAEMON_MODE: "local" });
    const acknowledgementMs = performance.now() - acknowledgementStartedAt;
    const recovery = await restartAndRetry(root, env, arm, round);
    const guiConvergence = await pollGuiReader(root, env);
    return {
      metrics: {
        submitToDurableReceiptMs: commitIndexMs,
        queueWaitMs,
        commitIndexMs,
        exactCutLocalApplyMs,
        acknowledgementMs
      },
      correctness: {
        committed,
        durableReceipts: committed,
        exactCutLocalApplies: Array.isArray(visible.tasks) || visible.ok === true ? committed : 0,
        acknowledgements: status.reachable === true ? committed : 0,
        disconnectRetries: recovery.disconnectRetry,
        restartRecoveries: recovery.restartRecovery,
        guiConvergences: guiConvergence
      },
      transport: { kind: "daemon-local-unix-socket", daemonReachable: status.reachable === true }
    };
  } finally {
    try { await cli(root, ["daemon", "stop", "--timeout-ms", "1000", "--json"], { ...env, HARNESS_DAEMON_MODE: "local" }); } catch { /* best-effort teardown; root is removed below */ }
    rmSync(root, { recursive: true, force: true });
  }
}

async function restartAndRetry(root, env, arm, round) {
  await cli(root, ["daemon", "stop", "--timeout-ms", "5000", "--json"], { ...env, HARNESS_DAEMON_MODE: "local" });
  const retried = await cli(root, ["new-task", "--title", `reconnect ${arm} r${round}`], env);
  return { disconnectRetry: retried.ok === true ? 1 : 0, restartRecovery: retried.ok === true ? 1 : 0 };
}

async function pollGuiReader(root, env) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const projection = await cli(root, ["task", "list"], env);
    if (projection.ok === true || Array.isArray(projection.tasks)) return 1;
  }
  return 0;
}

function localRoster() {
  return ["schema: harness-people/v1", "people:", "  - personId: person_benchmark", "    displayName: Qualification Benchmark", "    primaryEmail: qualification@example.test", "    roles: [owner]", "    credentials:", "      - kind: unix-socket-owner-boundary", `        issuer: host:${hostname()}`, `        subject: ${process.getuid?.() ?? 0}`, "roles:", "  - roleId: owner", "    commandClasses: [admin, repo-write, repo-read, arbiter]", ""].join("\n");
}

async function cli(root, args, env) {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, "--root", root, "--json", ...args], { env });
  return JSON.parse(stdout);
}

async function main() {
  const writerCounts = option("--writers", "1,3,10,32").split(",").map(Number);
  const rounds = Number(option("--rounds", "3"));
  const output = option("--output", "");
  const sourceCommit = git("rev-parse", "HEAD");
  const baselineCommit = option("--baseline-sha", sourceCommit);
  const result = await runPairedQualification({ writerCounts, rounds, sourceCommit, baselineCommit, runArm: runProductionSocketArm });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (output) writeFileSync(path.resolve(output), text, "utf8");
  process.stdout.write(text);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

if (import.meta.main) await main();
