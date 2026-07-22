#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { selectIntegrationShardFiles } from "./integration-test-shards.mjs";
import { formatTestWeightDriftWarnings, parseJunitTestFileDurations } from "./test-weight-drift.mjs";
import { discoverQosPrefix, prefixCommand, withLocalHeavySlot } from "./local-resource-governance.mjs";
import {
  collectSlowTests,
  filterTestFilesByPrefixes,
  formatSlowTestSummary,
  formatTestTimeoutGuidance,
  parseRunnerArgs,
  resolveTestConcurrency,
  selectTestFiles
} from "./node-test-runner-lib.mjs";
import { defaultTestTierNames, discoverTestTierManifest, testTierNames } from "./test-tier-manifest.mjs";
import { createHermeticTestEnvironment, gitFixtureIdentityGuidance } from "./test-process-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const PROCESS_TREE_KILL_GRACE_MS = 2_000;
const DEFAULT_STALL_DIAGNOSTIC_MS = 90_000;
// `--test-timeout` bounds any single test, so silence lasting several windows
// means the wedge is outside a test body — module load, a blocked thread, a
// child that never exits — where the per-test timeout can never fire. Reporting
// such a run forever is what let one wedged file burn a whole 15-minute CI job
// and take the pull request out of the merge queue with no test named.
const DEFAULT_STALL_ABORT_WINDOWS = 2;

// Reuse type-strip/compile output across the test host and every CLI
// subprocess it spawns (integration tests cold-start `node src/index.ts` per
// assertion). Native Node compile cache — no build step. Children inherit the
// env, so the cache is shared. Lives under node_modules/.cache (already
// git-ignored).
process.env.NODE_COMPILE_CACHE ||= resolve(repoRoot, "node_modules/.cache/harness-node-compile");
process.env.HARNESS_ACTOR ||= "agent:harness-test";
process.env.HARNESS_GIT_AUTHOR_NAME ||= "Harness Test";
process.env.HARNESS_GIT_AUTHOR_EMAIL ||= "harness@example.test";

let options;
try {
  options = parseRunnerArgs(process.argv.slice(2), testTierNames);
} catch (error) {
  console.error(error.message);
  await exitAfterStreamFlush(2);
}

const testTierManifest = discoverTestTierManifest(repoRoot);
const testFiles = Object.values(testTierManifest).flat().sort();
const selection = selectTestFiles(testFiles, testTierManifest, options.tier);
if (options.tier === "all") {
  selection.files = defaultTestTierNames.flatMap((tier) => testTierManifest[tier]).sort();
}

// Default CLI integration subprocesses preload a test-only fixture composition.
// Daemon-focused tests opt into HARNESS_DAEMON_MODE=local with isolated roots;
// no test re-enables the retired direct product writer.
if (options.tier === "integration" || options.tier === "nightly" || options.tier === "all") {
  const fixturePreload = `--import=${resolve(repoRoot, "tools/cli-test-fixture-register.mjs")}`;
  process.env.HARNESS_CLI_TEST_FIXTURE_PRELOAD = "1";
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, fixturePreload].filter(Boolean).join(" ");
}

if (selection.errors.length > 0) {
  for (const error of selection.errors) {
    console.error(error);
  }
  await exitAfterStreamFlush(1);
}

if (options.shard !== undefined) {
  selection.files = selectIntegrationShardFiles(options.shard, selection.files);
}
selection.files = filterTestFilesByPrefixes(selection.files, options.prefixes);

if (selection.files.length === 0) {
  console.log(`No node test files found for tier ${options.tier}.`);
  await exitAfterStreamFlush(0);
}

if (options.list) {
  for (const file of selection.files) {
    console.log(file);
  }
  await exitAfterStreamFlush(0);
}

// Cap process fan-out so full runs don't exhaust memory on developer laptops.
// --concurrency wins; else HARNESS_TEST_CONCURRENCY; else, off CI, a
// fixed per-session budget; in CI, node's own default.
const concurrency = resolveTestConcurrency({
  flagConcurrency: options.concurrency,
  envConcurrency: process.env.HARNESS_TEST_CONCURRENCY,
  isCi: Boolean(process.env.CI)
});
const concurrencyArgs =
  concurrency && Number.isInteger(concurrency) && concurrency > 0 ? [`--test-concurrency=${concurrency}`] : [];
const timeoutArgs = [`--test-timeout=${options.testTimeoutMs}`];
const timingRoot = mkdtempSync(path.join(tmpdir(), "ha-test-timings-"));
const timingPath = path.join(timingRoot, "results.xml");
const diagnosticReportArgs = process.platform === "win32"
  ? []
  : ["--report-on-signal", "--report-signal=SIGUSR2", `--report-directory=${timingRoot}`];
const stallDiagnosticMs = positiveIntegerOrDefault(
  process.env.HARNESS_TEST_STALL_DIAGNOSTIC_MS,
  DEFAULT_STALL_DIAGNOSTIC_MS
);
const stallAbortWindows = positiveIntegerOrDefault(
  process.env.HARNESS_TEST_STALL_ABORT_WINDOWS,
  DEFAULT_STALL_ABORT_WINDOWS
);
// Never preempt `--test-timeout`: while a test is running, that timeout ends it
// with the test named, which is strictly better evidence. Only silence outlasting
// the timeout itself proves no test is running, and therefore that nothing else
// will ever end this run.
const stallAbortAfterMs = Math.max(stallAbortWindows * stallDiagnosticMs, options.testTimeoutMs + stallDiagnosticMs);

process.exitCode = await withLocalHeavySlot({ label: `node-tests:${options.tier}` }, async (lease) => {
  const qosPrefix = lease.inherited ? [] : discoverQosPrefix();
  const invocation = prefixCommand(qosPrefix, process.execPath, [
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=${timingPath}`,
    ...diagnosticReportArgs,
    "--test-force-exit",
    ...concurrencyArgs,
    ...timeoutArgs,
    ...selection.files
  ]);
  const testEnvironment = createHermeticTestEnvironment(lease.childEnv);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repoRoot,
    stdio: ["inherit", "pipe", "pipe"],
    env: testEnvironment.env,
    detached: process.platform !== "win32"
  });

  let output = "";
  let lastOutputAt = Date.now();
  let consecutiveStallWindows = 0;
  let stallAbortStarted = false;
  const seenDiagnosticReports = new Set();
  const noteOutput = (text) => {
    // Asking a stalled host for a diagnostic report makes it print, and that
    // print is the runner's own echo, not progress. Counting it would clear the
    // stall streak on every window and the escalation could never be reached.
    if (isDiagnosticReportEcho(text)) return;
    lastOutputAt = Date.now();
    consecutiveStallWindows = 0;
  };
  const stallDiagnosticTimer = setInterval(() => {
    const silentForMs = Date.now() - lastOutputAt;
    if (silentForMs < stallDiagnosticMs) return;
    lastOutputAt = Date.now();
    consecutiveStallWindows += 1;
    emitStallDiagnostics({ child, silentForMs, timingRoot, seenDiagnosticReports });
    if (consecutiveStallWindows * stallDiagnosticMs < stallAbortAfterMs || stallAbortStarted) return;
    stallAbortStarted = true;
    void abortStalledRun({
      child,
      silentMs: consecutiveStallWindows * stallDiagnosticMs,
      silentWindows: consecutiveStallWindows,
      timeoutAlreadyReported: /test timed out after \d+ms/u.test(output)
    });
  }, stallDiagnosticMs);
  stallDiagnosticTimer.unref();
  let windowsTreeTerminationStarted = false;
  const terminateTimedOutWindowsTree = () => {
    if (process.platform !== "win32" || windowsTreeTerminationStarted || !/test timed out after \d+ms/u.test(output)) return;
    windowsTreeTerminationStarted = true;
    console.error("node --test reported a timeout; terminating its process tree");
    terminateWindowsProcessTree(child);
  };
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    noteOutput(text);
    output += text;
    process.stdout.write(text);
    terminateTimedOutWindowsTree();
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    noteOutput(text);
    output += text;
    process.stderr.write(text);
    terminateTimedOutWindowsTree();
  });

  return new Promise((resolveExitCode) => {
    child.once("error", (error) => {
      clearInterval(stallDiagnosticTimer);
      console.error(error.message);
      testEnvironment.cleanup();
      rmSync(timingRoot, { recursive: true, force: true });
      resolveExitCode(1);
    });
    child.once("close", async (code, signal) => {
      clearInterval(stallDiagnosticTimer);
      emitNewDiagnosticReports(timingRoot, seenDiagnosticReports);
      const leakedDescendants = await terminateLingeringPosixProcessGroup(child.pid);
      testEnvironment.cleanup();
      try {
        const measured = parseJunitTestFileDurations(readFileSync(timingPath, "utf8"), repoRoot);
        for (const warning of formatTestWeightDriftWarnings(measured)) console.warn(warning);
      } catch (error) {
        console.warn(`Unable to inspect test weight drift: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        rmSync(timingRoot, { recursive: true, force: true });
      }
      if (signal !== null) {
        console.error(`node --test terminated by signal ${signal}`);
      }
      if (code !== 0 || signal !== null) {
        const timeoutGuidance = formatTestTimeoutGuidance(output, options.testTimeoutMs);
        if (timeoutGuidance !== null) console.error(`\n${timeoutGuidance}`);
        const guidance = gitFixtureIdentityGuidance(output);
        if (guidance !== null) console.error(`\n${guidance}`);
      }
      const slowTests = collectSlowTests(output, options.slowThresholdMs);
      console.log(formatSlowTestSummary(slowTests, options.slowThresholdMs, options.slowLimit));
      resolveExitCode(signal === null && !leakedDescendants ? (code ?? 1) : 1);
    });
  });
});

function positiveIntegerOrDefault(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function exitAfterStreamFlush(code) {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  process.exit(code);
}

function flushStream(stream) {
  return new Promise((resolveFlush) => stream.write("", resolveFlush));
}

/**
 * Recognizes output that exists only because the stall probe asked for a report.
 * Node writes these two lines when it handles the report signal; a chunk made of
 * nothing else carries no evidence that the run is moving again.
 */
function isDiagnosticReportEcho(text) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return true;
  return lines.every((line) => /^Writing Node\.js report to file:/u.test(line) || /^Node\.js report completed$/u.test(line));
}

function emitStallDiagnostics({ child, silentForMs, timingRoot, seenDiagnosticReports }) {
  console.error(`\n[node-test-stall] no test output for ${silentForMs}ms; test host pid=${child.pid ?? "unknown"}`);
  console.error(`[node-test-stall] runner active resources: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  if (process.platform !== "win32" && child.pid !== undefined) {
    // Ask every report-capable group member, not just the host. Under
    // `--test-isolation=process` the host is only waiting on a per-file child,
    // so asking the host alone yields a report with an empty JavaScript stack
    // every time — the wedged process is the one that has to be asked. But a
    // blanket group signal would terminate members that never installed a
    // SIGUSR2 handler (a test's own spawned children), so only processes that
    // advertise `--report-on-signal` are asked.
    void signalReportCapableGroupMembers(child.pid);
    void dumpPosixProcessGroup(child.pid);
  }
  setTimeout(() => emitNewDiagnosticReports(timingRoot, seenDiagnosticReports), 1_000).unref();
}

/**
 * Ends a run whose output has stopped for several diagnostic windows. Node's own
 * `--test-timeout` cannot rescue this state, so the runner has to name what it
 * caught and fail, rather than stay silent until the CI job's own timeout kills
 * it with no test named.
 */
async function abortStalledRun({ child, silentMs, silentWindows, timeoutAlreadyReported }) {
  // When `--test-timeout` already fired, the failing test is named and this is
  // just the timeout path's own cleanup arriving early: the run lingers only
  // because a leaked descendant holds the process group open.
  if (timeoutAlreadyReported) {
    console.error("node --test reported a timeout; terminating its process tree");
    if (process.platform === "win32") {
      terminateWindowsProcessTree(child);
      return;
    }
    if (child.pid === undefined) return;
    signalProcessGroup(child.pid, "SIGTERM");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, PROCESS_TREE_KILL_GRACE_MS));
    signalProcessGroup(child.pid, "SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    console.error(`\n[node-test-stall] no test output for ${silentMs}ms across ${silentWindows} windows; terminating the test process tree`);
    terminateWindowsProcessTree(child);
    return;
  }
  if (child.pid === undefined) return;
  const stalledFiles = await stalledTestFilesInProcessGroup(child.pid);
  console.error(`\n[node-test-stall] no test output for ${silentMs}ms across ${silentWindows} windows; --test-timeout cannot fire here, so the runner is terminating the test process tree`);
  console.error(stalledFiles.length > 0
    ? `[node-test-stall] stalled test file(s): ${stalledFiles.join(", ")}`
    : "[node-test-stall] stalled test file could not be identified from the process group");
  signalProcessGroup(child.pid, "SIGTERM");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, PROCESS_TREE_KILL_GRACE_MS));
  signalProcessGroup(child.pid, "SIGKILL");
}

/**
 * Names the test files a wedged group is still holding. The test host lists every
 * selected file on its own command line, so only descendants are inspected: under
 * process isolation each of those runs exactly the file it is stuck on.
 */
async function stalledTestFilesInProcessGroup(processGroupId) {
  const lines = await readPosixProcessGroup(processGroupId);
  const descendantFiles = new Set();
  const hostFiles = new Set();
  for (const line of lines) {
    const pid = /^\s*(\d+)\s+/u.exec(line)?.[1];
    if (pid === undefined) continue;
    const target = pid === String(processGroupId) ? hostFiles : descendantFiles;
    for (const token of line.split(/\s+/u)) {
      if (/\.test\.(?:ts|tsx|mjs|cjs|js)$/u.test(token)) target.add(token);
    }
  }
  if (descendantFiles.size > 0) return [...descendantFiles];
  // Without process isolation the host itself is the wedged process, and its
  // command line is the whole selection rather than one file. Naming it is only
  // useful when the selection happens to be a single file.
  return hostFiles.size === 1 ? [...hostFiles] : [];
}

/**
 * Sends SIGUSR2 only to group members that run with `--report-on-signal` on
 * their command line. For anything else the default SIGUSR2 disposition is
 * termination, and killing a test's own child processes would corrupt the very
 * run the probe is trying to observe.
 */
async function signalReportCapableGroupMembers(processGroupId) {
  const lines = await readPosixProcessGroup(processGroupId);
  for (const line of lines) {
    if (!line.includes("--report-on-signal")) continue;
    const pid = Number(/^\s*(\d+)\s+/u.exec(line)?.[1]);
    if (!Number.isSafeInteger(pid)) continue;
    try {
      process.kill(pid, "SIGUSR2");
    } catch {
      // The process may have exited between the listing and the signal.
    }
  }
}

async function dumpPosixProcessGroup(processGroupId) {
  const lines = await readPosixProcessGroup(processGroupId);
  const columnDescription = process.platform === "darwin"
    ? "pid ppid pgid stat elapsed argv"
    : "pid ppid pgid stat elapsed wait-channel argv";
  console.error(`[node-test-stall] process group (${columnDescription}):`);
  console.error(lines.length > 0 ? lines.join("\n") : `[node-test-stall] no processes found for pgid ${processGroupId}`);
}

function readPosixProcessGroup(processGroupId) {
  const psColumns = process.platform === "darwin"
    ? "pid=,ppid=,pgid=,stat=,etime=,command="
    : "pid=,ppid=,pgid=,stat=,etime=,wchan:32=,args=";
  return new Promise((resolveLines) => {
    const ps = spawn("ps", ["-eo", psColumns], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    ps.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    ps.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    ps.once("error", (error) => {
      console.error(`[node-test-stall] unable to inspect process group: ${error.message}`);
      resolveLines([]);
    });
    ps.once("close", (code) => {
      if (code !== 0) {
        console.error(`[node-test-stall] ps exited ${code}: ${stderr.trim()}`);
        resolveLines([]);
        return;
      }
      resolveLines(stdout.split(/\r?\n/u).filter((line) => {
        const match = /^\s*\d+\s+\d+\s+(\d+)\s+/u.exec(line);
        return match?.[1] === String(processGroupId);
      }));
    });
  });
}

function emitNewDiagnosticReports(timingRoot, seenDiagnosticReports) {
  let reportNames;
  try {
    reportNames = readdirSync(timingRoot).filter((name) => /^report\..+\.json$/u.test(name));
  } catch {
    return;
  }
  for (const reportName of reportNames) {
    if (seenDiagnosticReports.has(reportName)) continue;
    seenDiagnosticReports.add(reportName);
    try {
      const report = JSON.parse(readFileSync(path.join(timingRoot, reportName), "utf8"));
      const activeLibuv = Array.isArray(report.libuv)
        ? report.libuv.filter((handle) => handle?.is_active || handle?.is_referenced)
          .map((handle) => ({
            type: handle.type,
            isActive: handle.is_active,
            isReferenced: handle.is_referenced,
            pid: handle.pid,
            fd: handle.fd,
            signal: handle.signal,
            firesInMsFromNow: handle.firesInMsFromNow
          }))
        : [];
      console.error(`[node-test-stall] diagnostic report ${reportName}`);
      console.error(`[node-test-stall] javascript stack: ${report.javascriptStack?.message ?? "unavailable"}`);
      console.error(`[node-test-stall] active libuv handles: ${JSON.stringify(activeLibuv)}`);
    } catch (error) {
      console.error(`[node-test-stall] unable to read ${reportName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function terminateWindowsProcessTree(child) {
  if (child.pid === undefined) return;
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  killer.once("error", () => child.kill("SIGKILL"));
}

async function terminateLingeringPosixProcessGroup(pid) {
  if (process.platform === "win32" || pid === undefined || !signalProcessGroup(pid, "SIGTERM")) return false;
  console.error("node --test completed with lingering descendants; terminating its process tree");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, PROCESS_TREE_KILL_GRACE_MS));
  signalProcessGroup(pid, "SIGKILL");
  return true;
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return false;
  }
}
