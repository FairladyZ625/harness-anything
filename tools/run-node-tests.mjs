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
  const seenDiagnosticReports = new Set();
  const noteOutput = () => {
    lastOutputAt = Date.now();
  };
  const stallDiagnosticTimer = setInterval(() => {
    const silentForMs = Date.now() - lastOutputAt;
    if (silentForMs < stallDiagnosticMs) return;
    lastOutputAt = Date.now();
    emitStallDiagnostics({ child, silentForMs, timingRoot, seenDiagnosticReports });
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
    noteOutput();
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
    terminateTimedOutWindowsTree();
  });
  child.stderr.on("data", (chunk) => {
    noteOutput();
    const text = chunk.toString();
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

function emitStallDiagnostics({ child, silentForMs, timingRoot, seenDiagnosticReports }) {
  console.error(`\n[node-test-stall] no test output for ${silentForMs}ms; test host pid=${child.pid ?? "unknown"}`);
  console.error(`[node-test-stall] runner active resources: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  if (process.platform !== "win32" && child.pid !== undefined) {
    child.kill("SIGUSR2");
    dumpPosixProcessGroup(child.pid);
  }
  setTimeout(() => emitNewDiagnosticReports(timingRoot, seenDiagnosticReports), 1_000).unref();
}

function dumpPosixProcessGroup(processGroupId) {
  const psColumns = process.platform === "darwin"
    ? "pid=,ppid=,pgid=,stat=,etime=,command="
    : "pid=,ppid=,pgid=,stat=,etime=,wchan:32=,args=";
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
  ps.once("error", (error) => console.error(`[node-test-stall] unable to inspect process group: ${error.message}`));
  ps.once("close", (code) => {
    if (code !== 0) {
      console.error(`[node-test-stall] ps exited ${code}: ${stderr.trim()}`);
      return;
    }
    const groupLines = stdout.split(/\r?\n/u).filter((line) => {
      const match = /^\s*\d+\s+\d+\s+(\d+)\s+/u.exec(line);
      return match?.[1] === String(processGroupId);
    });
    const columnDescription = process.platform === "darwin"
      ? "pid ppid pgid stat elapsed argv"
      : "pid ppid pgid stat elapsed wait-channel argv";
    console.error(`[node-test-stall] process group (${columnDescription}):`);
    console.error(groupLines.length > 0 ? groupLines.join("\n") : `[node-test-stall] no processes found for pgid ${processGroupId}`);
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
