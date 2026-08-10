#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { integrationShardCount, selectIntegrationShardFiles } from "./integration-test-shards.mjs";
import {
  createIntegrationTestTimingReport,
  packageLockFingerprint,
  writeIntegrationTestTimingReport
} from "./integration-test-timing.mjs";
import { formatTestWeightDriftWarnings, parseJunitTestFileDurations } from "./test-weight-drift.mjs";
import { discoverQosPrefix, withLocalHeavySlot } from "./local-resource-governance.mjs";
import { runNodeTestFileSchedule } from "./node-test-file-scheduler.mjs";
import {
  collectSlowTests,
  filterTestFilesByPrefixes,
  formatSlowTestSummary,
  formatTestTimeoutGuidance,
  parseNodeTestV8Flags,
  parseRunnerArgs,
  resolveTestConcurrency,
  selectTestFiles
} from "./node-test-runner-lib.mjs";
import { persistNodeTestFailureDiagnostics } from "./node-test-stall-diagnostics.mjs";
import {
  DEFAULT_NODE_TEST_STALL_ABORT_WINDOWS,
  DEFAULT_NODE_TEST_STALL_DIAGNOSTIC_MS
} from "./node-test-stall-policy.mjs";
import { defaultTestTierNames, discoverTestTierManifest, testTierNames } from "./test-tier-manifest.mjs";
import { createHermeticTestEnvironment, gitFixtureIdentityGuidance } from "./test-process-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const timingOutput = process.env.HARNESS_INTEGRATION_TIMING_OUTPUT;

// Native Node compile cache is shared by every directly owned file worker and
// by the CLI subprocesses spawned from integration tests.
process.env.NODE_COMPILE_CACHE ||= resolve(repoRoot, "node_modules/.cache/harness-node-compile");
process.env.HARNESS_ACTOR ||= "agent:harness-test";
process.env.HARNESS_GIT_AUTHOR_NAME ||= "Harness Test";
process.env.HARNESS_GIT_AUTHOR_EMAIL ||= "harness@example.test";

let options;
let nodeTestV8Flags;
try {
  options = parseRunnerArgs(process.argv.slice(2), testTierNames);
  nodeTestV8Flags = parseNodeTestV8Flags(process.env.HARNESS_NODE_TEST_V8_FLAGS);
} catch (error) {
  console.error(error.message);
  await exitAfterStreamFlush(2);
}

if (timingOutput !== undefined && (options.tier !== "integration" || options.shard === undefined)) {
  console.error("HARNESS_INTEGRATION_TIMING_OUTPUT requires --tier integration with --shard");
  await exitAfterStreamFlush(2);
}

const testTierManifest = discoverTestTierManifest(repoRoot);
const integrationManifestFiles = [...testTierManifest.integration];
const testFiles = Object.values(testTierManifest).flat().sort();
const selection = selectTestFiles(testFiles, testTierManifest, options.tier);
if (options.tier === "all") {
  selection.files = defaultTestTierNames.flatMap((tier) => testTierManifest[tier]).sort();
}

if (options.tier === "integration" || options.tier === "nightly" || options.tier === "all") {
  const fixturePreload = `--import=${pathToFileURL(resolve(repoRoot, "tools/cli-test-fixture-register.mjs")).href}`;
  process.env.HARNESS_CLI_TEST_FIXTURE_PRELOAD = "1";
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, fixturePreload].filter(Boolean).join(" ");
}

if (selection.errors.length > 0) {
  for (const error of selection.errors) console.error(error);
  await exitAfterStreamFlush(1);
}

if (options.shard !== undefined) {
  selection.files = selectIntegrationShardFiles(options.shard, selection.files);
}
selection.files = filterTestFilesByPrefixes(selection.files, options.prefixes);
if (options.files.length > 0) {
  const eligibleFiles = new Set(selection.files);
  const missingFiles = options.files.filter((file) => !eligibleFiles.has(file));
  if (missingFiles.length > 0) {
    for (const file of missingFiles) console.error(`requested test file is not selected by tier manifest: ${file}`);
    await exitAfterStreamFlush(1);
  }
  selection.files = [...new Set(options.files)].sort();
}
if (options.fixtures.length > 0) {
  const missingFixtures = options.fixtures.filter((file) => !existsSync(resolve(repoRoot, file)));
  if (missingFixtures.length > 0) {
    for (const file of missingFixtures) console.error(`runner fixture does not exist: ${file}`);
    await exitAfterStreamFlush(1);
  }
  selection.files = [...new Set(options.fixtures)].sort();
}

if (selection.files.length === 0) {
  console.log(`No node test files found for tier ${options.tier}.`);
  await exitAfterStreamFlush(0);
}

if (options.list) {
  for (const file of selection.files) console.log(file);
  await exitAfterStreamFlush(0);
}

const requestedConcurrency = resolveTestConcurrency({
  flagConcurrency: options.concurrency,
  envConcurrency: process.env.HARNESS_TEST_CONCURRENCY,
  isCi: Boolean(process.env.CI)
});
// Node's test runner uses available parallelism minus one when the caller does
// not provide a cap. Once Harness owns file spawning, that implicit default has
// to become an explicit scheduler input to preserve CI fan-out.
const concurrency = requestedConcurrency ?? Math.max(1, availableParallelism() - 1);
const timingRoot = mkdtempSync(path.join(tmpdir(), "ha-test-timings-"));
const junitRoot = path.join(timingRoot, "junit");
const stallReportRoot = mkdtempSync(path.join(timingRoot, "stall-reports-"));
const stallDiagnosticMs = positiveIntegerOrDefault(
  process.env.HARNESS_TEST_STALL_DIAGNOSTIC_MS,
  DEFAULT_NODE_TEST_STALL_DIAGNOSTIC_MS
);
const stallAbortWindows = positiveIntegerOrDefault(
  process.env.HARNESS_TEST_STALL_ABORT_WINDOWS,
  DEFAULT_NODE_TEST_STALL_ABORT_WINDOWS
);

try {
  process.exitCode = await withLocalHeavySlot({ label: `node-tests:${options.tier}` }, async (lease) => {
    if (nodeTestV8Flags.length > 0) {
      console.error(`[node-test-experiment] explicit V8 flags: ${nodeTestV8Flags.join(" ")}`);
    }
    const commandPrefix = lease.inherited ? [] : discoverQosPrefix();
    const testEnvironment = createHermeticTestEnvironment(lease.childEnv);
    let schedule;
    try {
      schedule = await runNodeTestFileSchedule({
        files: selection.files,
        concurrency,
        env: testEnvironment.env,
        nodeTestV8Flags,
        commandPrefix,
        testTimeoutMs: options.testTimeoutMs,
        diagnosticIntervalMs: stallDiagnosticMs,
        abortWindows: stallAbortWindows,
        junitRoot,
        stallReportRoot,
        onEvent: process.env.HARNESS_NODE_TEST_EVENT_TRACE === "1"
          ? (event) => console.error(`[node-test-worker-event] ${JSON.stringify(event)}`)
          : undefined
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      persistNodeTestFailureDiagnostics({
        completionOutput: "",
        error: error instanceof Error ? error.message : String(error),
        exitCode: null,
        leakedDescendants: false,
        nodeTestV8Flags,
        reapedFiles: new Set(),
        repoRoot,
        selectedFiles: selection.files,
        signal: null,
        tier: options.tier,
        timingRoot
      });
      return 1;
    } finally {
      testEnvironment.cleanup();
    }

    const combinedOutput = schedule.workers
      .map((worker) => `${worker.output}${worker.errorOutput}`)
      .join("");
    printAggregateSummary(schedule.counts, schedule.durationMs);
    inspectWeightDrift(schedule.workers);
    const slowTests = collectSlowTests(combinedOutput, options.slowThresholdMs);
    console.log(formatSlowTestSummary(slowTests, options.slowThresholdMs, options.slowLimit));

    const reapedFiles = new Set(schedule.workers
      .filter((worker) => worker.outcome === "passed-after-reap")
      .map((worker) => worker.file));
    if (reapedFiles.size > 0) {
      console.error(
        `[node-test-stall] accepted ${reapedFiles.size} completed file result(s); ignoring only the host-generated forced-termination file failure(s) is no longer part of verdict authority; typed proof accepted the direct worker result`
      );
    }

    if (schedule.exitCode !== 0) {
      const timeoutGuidance = formatTestTimeoutGuidance(combinedOutput, options.testTimeoutMs);
      if (timeoutGuidance !== null) console.error(`\n${timeoutGuidance}`);
      const identityGuidance = gitFixtureIdentityGuidance(combinedOutput);
      if (identityGuidance !== null) console.error(`\n${identityGuidance}`);
      persistNodeTestFailureDiagnostics({
        completionOutput: schedule.workers.map((worker) => worker.completionOutput).join(""),
        error: null,
        exitCode: schedule.exitCode,
        leakedDescendants: false,
        nodeTestV8Flags,
        reapedFiles,
        repoRoot,
        selectedFiles: selection.files,
        signal: null,
        tier: options.tier,
        timingRoot
      });
    }
    if (schedule.exitCode === 0 && timingOutput !== undefined) {
      const report = createIntegrationTestTimingReport({
        manifestFiles: integrationManifestFiles,
        workers: schedule.workers,
        shardId: Number(options.shard),
        shardCount: integrationShardCount,
        source: integrationTimingSource(),
        nodeVersion: process.version,
        packageLockSha256: packageLockFingerprint(repoRoot)
      });
      writeIntegrationTestTimingReport(resolveTimingOutput(timingOutput), report);
      console.log(`Integration timing artifact: ${timingOutput} (${report.files.length} files)`);
    }
    return schedule.exitCode;
  });
} finally {
  rmSync(timingRoot, { recursive: true, force: true });
}

function inspectWeightDrift(workers) {
  const measured = new Map();
  try {
    for (const worker of workers) {
      if (!existsSync(worker.junitPath)) continue;
      const fileDurations = parseJunitTestFileDurations(readFileSync(worker.junitPath, "utf8"), repoRoot);
      for (const [file, durationMs] of fileDurations) {
        measured.set(file, (measured.get(file) ?? 0) + durationMs);
      }
    }
    for (const warning of formatTestWeightDriftWarnings(measured)) console.warn(warning);
  } catch (error) {
    console.warn(`Unable to inspect test weight drift: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printAggregateSummary(counts, durationMs) {
  console.log(`ℹ tests ${counts.tests}`);
  console.log("ℹ suites 0");
  console.log(`ℹ pass ${counts.passed}`);
  console.log(`ℹ fail ${counts.failed}`);
  console.log(`ℹ cancelled ${counts.cancelled}`);
  console.log(`ℹ skipped ${counts.skipped}`);
  console.log(`ℹ todo ${counts.todo}`);
  console.log(`ℹ duration_ms ${durationMs.toFixed(6)}`);
}

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

function integrationTimingSource() {
  const commitSha = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? "1");
  return {
    repository: process.env.GITHUB_REPOSITORY ?? "local/harness-anything",
    commitSha,
    runId: process.env.GITHUB_RUN_ID ?? `local-${commitSha.slice(0, 12)}`,
    runAttempt: Number.isSafeInteger(runAttempt) && runAttempt > 0 ? runAttempt : 1
  };
}

function resolveTimingOutput(value) {
  const output = resolve(repoRoot, value);
  const relative = path.relative(repoRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("HARNESS_INTEGRATION_TIMING_OUTPUT must stay inside the repository root");
  }
  return output;
}
