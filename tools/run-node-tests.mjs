#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { selectIntegrationShardFiles } from "./integration-test-shards.mjs";
import { formatTestWeightDriftWarnings, parseJunitTestFileDurations } from "./test-weight-drift.mjs";
import { discoverQosPrefix, prefixCommand, withLocalHeavySlot } from "./local-resource-governance.mjs";
import {
  collectSlowTests,
  filterTestFilesByPrefixes,
  formatSlowTestSummary,
  formatTestTimeoutGuidance,
  hasIsolationWedgeSignature,
  parsePosixProcessGroupLine,
  parseRunnerArgs,
  resolveTestConcurrency,
  selectTestFiles,
  testFilesFromProcessCommand
} from "./node-test-runner-lib.mjs";
import { createNodeTestStallPolicy } from "./node-test-stall-policy.mjs";
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
const stallDiagnosticMs = positiveIntegerOrDefault(
  process.env.HARNESS_TEST_STALL_DIAGNOSTIC_MS,
  DEFAULT_STALL_DIAGNOSTIC_MS
);
const stallAbortWindows = positiveIntegerOrDefault(
  process.env.HARNESS_TEST_STALL_ABORT_WINDOWS,
  DEFAULT_STALL_ABORT_WINDOWS
);

process.exitCode = await withLocalHeavySlot({ label: `node-tests:${options.tier}` }, async (lease) => {
  const qosPrefix = lease.inherited ? [] : discoverQosPrefix();
  const invocation = prefixCommand(qosPrefix, process.execPath, [
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=${timingPath}`,
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
  const removeParentSignalForwarding = installTestTreeSignalForwarding(child);

  let output = "";
  let stallAbortStarted = false;
  let stallTickStarted = false;
  const stallPolicy = createNodeTestStallPolicy({
    diagnosticIntervalMs: stallDiagnosticMs,
    abortWindows: stallAbortWindows,
    testTimeoutMs: options.testTimeoutMs,
    startedAt: performance.now()
  });
  const noteOutput = (text) => {
    stallPolicy.noteOutput(text, performance.now());
  };
  const startStallAbort = (input) => {
    if (stallAbortStarted) return;
    stallAbortStarted = true;
    void abortStalledRun({ child, ...input });
  };
  const inspectStallState = async () => {
    if (stallTickStarted || stallAbortStarted) return;
    stallTickStarted = true;
    try {
      const processGroupLines = process.platform === "win32" || child.pid === undefined
        ? []
        : await readPosixProcessGroup(child.pid);
      if (child.exitCode !== null || child.signalCode !== null || stallAbortStarted) return;
      const processGroupMembers = processGroupLines
        .map((line) => parsePosixProcessGroupLine(line))
        .filter((member) => member !== null);
      const isolationCandidates = isolationCandidatesFromProcessGroup(
        processGroupMembers,
        child.pid
      );
      const decision = stallPolicy.tick({
        at: performance.now(),
        isolationCandidates
      });
      if (decision.diagnostic !== null) {
        emitStallDiagnostics({
          child,
          silentForMs: decision.diagnostic.silentForMs,
          processGroupLines
        });
      }
      if (decision.abort === null) return;
      const snapshotFiles = stalledTestFilesFromProcessGroup(processGroupMembers, child.pid);
      startStallAbort({
        silentMs: decision.abort.silentMs,
        silentWindows: decision.abort.silentWindows,
        timeoutAlreadyReported: /test timed out after \d+ms/u.test(output),
        isolationChildPid: decision.abort.kind === "isolation-wedge"
          ? decision.abort.isolationChildPid
          : undefined,
        stalledFiles: decision.abort.kind === "isolation-wedge"
          ? decision.abort.files
          : snapshotFiles
      });
    } finally {
      stallTickStarted = false;
    }
  };
  const stallDiagnosticTimer = setInterval(() => {
    void inspectStallState();
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
      removeParentSignalForwarding();
      console.error(error.message);
      testEnvironment.cleanup();
      rmSync(timingRoot, { recursive: true, force: true });
      resolveExitCode(1);
    });
    child.once("close", async (code, signal) => {
      clearInterval(stallDiagnosticTimer);
      removeParentSignalForwarding();
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

function emitStallDiagnostics({
  child,
  silentForMs,
  processGroupLines
}) {
  console.error(`\n[node-test-stall] no test output for ${silentForMs}ms; test host pid=${child.pid ?? "unknown"}`);
  console.error(`[node-test-stall] runner active resources: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  if (process.platform !== "win32" && child.pid !== undefined) {
    // Diagnostics are deliberately observational. Signaling a process merely
    // because its argv advertises `--report-on-signal` races Node's handler
    // installation and can turn the probe itself into the cause of failure.
    dumpPosixProcessGroup(processGroupLines, child.pid);
  }
}

/**
 * Ends a run whose output has stopped for several diagnostic windows. Node's own
 * `--test-timeout` cannot rescue this state, so the runner has to name what it
 * caught and fail, rather than stay silent until the CI job's own timeout kills
 * it with no test named.
 */
async function abortStalledRun({ child, silentMs, silentWindows, timeoutAlreadyReported, isolationChildPid, stalledFiles }) {
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
  const namedFiles = stalledFiles ?? [];
  const reason = isolationChildPid === undefined
    ? `no test output for ${silentMs}ms across ${silentWindows} windows`
    : `isolation child pid=${isolationChildPid} remained wedged for ${silentMs}ms across ${silentWindows} windows`;
  console.error(`\n[node-test-stall] ${reason}; --test-timeout cannot fire here, so the runner is terminating the test process tree`);
  console.error(namedFiles.length > 0
    ? `[node-test-stall] stalled test file(s): ${namedFiles.join(", ")}`
    : "[node-test-stall] stalled test file could not be identified from the process group");
  signalProcessGroup(child.pid, "SIGTERM");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, PROCESS_TREE_KILL_GRACE_MS));
  signalProcessGroup(child.pid, "SIGKILL");
}

/**
 * Converts one process-group snapshot into the scheduler-independent evidence
 * consumed by the stall policy.
 */
function isolationCandidatesFromProcessGroup(members, processGroupId) {
  return members
    .filter((member) => member.pid !== processGroupId && hasIsolationWedgeSignature(member))
    .map((member) => ({
      pid: member.pid,
      files: testFilesFromProcessCommand(member.command, repoRoot)
    }))
    .filter((candidate) => candidate.files.length > 0);
}

/**
 * Names the test files a group is still holding from the same snapshot that
 * triggered the policy decision. Re-reading after the decision introduces a
 * race with process exit and can lose the only useful file evidence.
 */
function stalledTestFilesFromProcessGroup(members, processGroupId) {
  const descendantFiles = new Set();
  const hostFiles = new Set();
  for (const member of members) {
    const target = member.pid === processGroupId ? hostFiles : descendantFiles;
    for (const file of testFilesFromProcessCommand(member.command, repoRoot)) target.add(file);
  }
  if (descendantFiles.size > 0) return [...descendantFiles];
  // Without process isolation the host itself is the wedged process, and its
  // command line is the whole selection rather than one file. Naming it is only
  // useful when the selection happens to be a single file.
  return hostFiles.size === 1 ? [...hostFiles] : [];
}

function dumpPosixProcessGroup(lines, processGroupId) {
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

/**
 * The test host owns a detached process group on POSIX so ordinary cleanup can
 * terminate every descendant. That also means a signal sent only to this
 * wrapper would otherwise orphan the group. Forward parent termination before
 * the local-resource lease handler re-raises the signal with its default
 * disposition.
 */
function installTestTreeSignalForwarding(child) {
  const handlers = new Map();
  const remove = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      remove();
      try {
        if (process.platform === "win32") {
          terminateWindowsProcessTree(child);
        } else if (child.pid !== undefined) {
          signalProcessGroup(child.pid, signal);
        }
      } finally {
        // This listener intentionally runs first. Re-raising preserves the
        // caller-visible signal exit after the process tree has been cleaned.
        process.kill(process.pid, signal);
      }
    };
    handlers.set(signal, handler);
    process.prependOnceListener(signal, handler);
  }
  return remove;
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
