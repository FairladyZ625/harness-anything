#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { runFileWorkerSchedule } from "./file-worker-scheduler-prototype.mjs";
import { createHermeticTestEnvironment } from "../test-process-environment.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(import.meta.dirname, "run-file-worker-prototype.mjs");
const completionReporterUrl = pathToFileURL(
  path.join(repoRoot, "tools/node-test-completion-reporter.mjs")
).href;
const fixturePreload = `--import=${pathToFileURL(
  path.join(repoRoot, "tools/cli-test-fixture-register.mjs")
).href}`;
const concurrency = 2;
const afterCompletionWedge = "tools/test-fixtures/.runner-stall/post-complete-wedge.test.mjs";
const beforeCompletionWedge = "tools/test-fixtures/.runner-stall/wedged-module.test.mjs";
const failureExitWedge = "tools/test-fixtures/.file-worker-prototype/failure-post-complete-wedge.test.mjs";
const parentSignalFiles = [
  "tools/test-fixtures/.file-worker-prototype/parent-signal-a.test.mjs",
  "tools/test-fixtures/.file-worker-prototype/parent-signal-b.test.mjs"
];
const coldStartFixture = "tools/test-fixtures/.runner-stall/chatter.test.mjs";
const representativeFiles = Object.freeze({
  fast: [
    "packages/adapters/github-issues/test/github-ref-mapper.test.ts",
    "packages/application/test/actor-axes-binding-v2.test.ts",
    "packages/cli/test/cas-parse-args.test.ts",
    "packages/daemon/test/authority-key-store.test.ts",
    "packages/gui/test/favorites-storage.test.ts"
  ],
  integration: [
    "packages/adapters/multica/test/multica-readonly-adopt.test.ts",
    "packages/application/test/execution-saga.test.ts",
    "packages/cli/test/progress-evidence-cli.test.ts",
    "packages/daemon/test/transport-integration.test.ts",
    "packages/kernel/test/store/payload-hash.test.ts"
  ]
});

const [mode = "all", ...args] = process.argv.slice(2);
if (mode === "schedule-parent-signal") {
  await runParentSignalChild();
} else {
  const samples = sampleCount(args);
  const output = {
    schema: "harness-file-worker-prototype-findings/v1",
    generatedAt: new Date().toISOString(),
    environment: runtimeEnvironment(),
    correctness: mode === "benchmark" ? undefined : await runCorrectnessControls(),
    performance: mode === "correctness" ? undefined : await runPerformanceComparison(samples)
  };
  console.log(JSON.stringify(output, null, 2));
}

async function runCorrectnessControls() {
  const controls = [];
  controls.push(await runDirectControl({
    name: "completion-after-exit-wedge",
    file: afterCompletionWedge,
    fixture: "post-complete-wedge",
    expectedOutcome: "passed-after-reap",
    expectedFailure: null,
    expectedProof: true
  }));
  controls.push(await runDirectControl({
    name: "wedge-before-completion",
    file: beforeCompletionWedge,
    fixture: "wedge",
    expectedOutcome: "failed",
    expectedFailure: {
      name: beforeCompletionWedge,
      kind: "deadline-before-proof"
    },
    expectedProof: false
  }));
  controls.push(await runDirectControl({
    name: "real-failure-plus-exit-wedge",
    file: failureExitWedge,
    fixture: "failure-post-complete-wedge",
    expectedOutcome: "failed-after-reap",
    expectedFailure: {
      name: "prototype preserves the real failure before an exit wedge",
      kind: "test-failure"
    },
    expectedProof: true,
    expectedProofSuccess: false
  }));
  controls.push(await runParentSignalControl());
  return {
    verdictInputs: [
      "spawn-time worker id plus direct ChildProcess handle",
      "structured JSONL proof on fd 3",
      "direct worker close event",
      "owned process-group termination effect"
    ],
    forbiddenVerdictInputs: ["ps", "wchan", "registry", "stdout regex"],
    controls
  };
}

async function runDirectControl({
  name,
  file,
  fixture,
  expectedOutcome,
  expectedFailure,
  expectedProof,
  expectedProofSuccess = true
}) {
  return withPrototypeEnvironment({
    HARNESS_FILE_WORKER_FIXTURE: fixture,
    HARNESS_RUNNER_STALL_FIXTURE: fixture
  }, async (env) => {
    const result = await runFileWorkerSchedule({
      files: [file],
      concurrency: 1,
      env,
      testTimeoutMs: 5_000,
      workerDeadlineMs: 500,
      proofExitGraceMs: 250,
      terminationGraceMs: 100
    });
    const worker = result.workers[0];
    assert.equal(worker.outcome, expectedOutcome, JSON.stringify(result, null, 2));
    assert.deepEqual(worker.failure, expectedFailure, JSON.stringify(result, null, 2));
    assert.equal(worker.proof !== null, expectedProof, JSON.stringify(result, null, 2));
    if (expectedProof) {
      assert.equal(worker.proof.success, expectedProofSuccess, JSON.stringify(result, null, 2));
    }
    assertTrace(worker.trace, expectedProof);
    return {
      name,
      assertion: "pass",
      scheduleExitCode: result.exitCode,
      worker: publicWorkerResult(worker)
    };
  });
}

async function runParentSignalControl() {
  const pidRoot = mkdtempSync(path.join(tmpdir(), "ha-file-worker-parent-signal-"));
  try {
    return await withPrototypeEnvironment({
      HARNESS_FILE_WORKER_FIXTURE: "parent-signal",
      HARNESS_FILE_WORKER_PID_ROOT: pidRoot
    }, async (env) => {
      const child = spawn(process.execPath, [scriptPath, "schedule-parent-signal"], {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const output = collectChild(child, 15_000);
      await waitFor(() => parentSignalRecords(pidRoot).length === parentSignalFiles.length, 5_000);
      const records = parentSignalRecords(pidRoot);
      child.kill("SIGTERM");
      const closed = await output;
      assert.equal(closed.error, null, closed.stderr);
      assert.equal(closed.signal, null, closed.stderr);
      assert.equal(closed.code, 1, closed.stderr);
      const schedule = JSON.parse(closed.stdout.trim());
      assert.equal(schedule.verdict, "fail", closed.stdout);
      assert.equal(schedule.workers.length, parentSignalFiles.length, closed.stdout);
      assert.equal(schedule.workers.every((worker) =>
        worker.failure?.kind === "parent-signal:SIGTERM"), true, closed.stdout);
      await waitFor(() => records.every(({ workerPid, descendantPid }) =>
        !processIsAlive(workerPid) && !processIsAlive(descendantPid)), 5_000);
      for (const worker of schedule.workers) assertTrace(worker.trace, false);
      return {
        name: "parent-signal-reaps-all-direct-worker-trees",
        assertion: "pass",
        schedulerClose: { code: closed.code, signal: closed.signal },
        observedPids: records,
        allObservedPidsReaped: records.every(({ workerPid, descendantPid }) =>
          !processIsAlive(workerPid) && !processIsAlive(descendantPid)),
        workers: schedule.workers.map(publicWorkerResult)
      };
    });
  } finally {
    rmSync(pidRoot, { recursive: true, force: true });
  }
}

async function runParentSignalChild() {
  const abortController = new AbortController();
  let parentSignal = null;
  const onSigterm = () => {
    parentSignal = "SIGTERM";
    abortController.abort({ signal: parentSignal });
  };
  const onSigint = () => {
    parentSignal = "SIGINT";
    abortController.abort({ signal: parentSignal });
  };
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  const result = await runFileWorkerSchedule({
    files: parentSignalFiles,
    concurrency: parentSignalFiles.length,
    env: process.env,
    workerDeadlineMs: 30_000,
    proofExitGraceMs: 1_000,
    terminationGraceMs: 150,
    abortSignal: abortController.signal
  });
  process.removeListener("SIGTERM", onSigterm);
  process.removeListener("SIGINT", onSigint);
  console.log(JSON.stringify(result));
  process.exitCode = parentSignal === null ? result.exitCode : 1;
}

async function runPerformanceComparison(samples) {
  const tiers = {};
  for (const [tier, files] of Object.entries(representativeFiles)) {
    tiers[tier] = await benchmarkTier(tier, files, samples);
  }
  const aggregateBaseline = tiers.fast.samplesMs.map(
    (duration, index) => duration + tiers.integration.samplesMs[index]
  );
  const aggregateCandidate = tiers.fast.candidateSamplesMs.map(
    (duration, index) => duration + tiers.integration.candidateSamplesMs[index]
  );
  const aggregate = comparisonSummary(aggregateBaseline, aggregateCandidate);
  const coldStart = await benchmarkColdStart(Math.max(samples, 30));
  const thresholdExceeded = [tiers.fast, tiers.integration, aggregate]
    .some((comparison) => comparison.p95RegressionPercent > 15);
  return {
    concurrency,
    measuredSamplesPerArchitecturePerTier: samples,
    warmupsPerArchitecturePerTier: 1,
    representativeFiles,
    baselineShape: "one top-level node --test host, default process isolation, five files",
    candidateShape: "scheduler with one top-level node --test --test-isolation=none worker per file",
    tiers,
    aggregate,
    coldStart,
    acceptanceThreshold: "candidate p95 regression must be <= 15%",
    thresholdExceeded
  };
}

async function benchmarkTier(tier, files, samples) {
  return withPrototypeEnvironment({}, async (baseEnv) => {
    const env = tier === "integration" ? integrationEnvironment(baseEnv) : baseEnv;
    await runBaseline(files, env);
    await runCandidate(files, env);
    const baselineSamples = [];
    const candidateSamples = [];
    const candidateWorkerSamples = [];
    for (let index = 0; index < samples; index += 1) {
      if (index % 2 === 0) {
        baselineSamples.push((await runBaseline(files, env)).durationMs);
        const candidate = await runCandidate(files, env);
        candidateSamples.push(candidate.durationMs);
        candidateWorkerSamples.push(...candidate.workers.map((worker) => worker.durationMs));
      } else {
        const candidate = await runCandidate(files, env);
        candidateSamples.push(candidate.durationMs);
        candidateWorkerSamples.push(...candidate.workers.map((worker) => worker.durationMs));
        baselineSamples.push((await runBaseline(files, env)).durationMs);
      }
    }
    return {
      ...comparisonSummary(baselineSamples, candidateSamples),
      samplesMs: baselineSamples.map(roundMilliseconds),
      candidateSamplesMs: candidateSamples.map(roundMilliseconds),
      candidateWorkerDuration: distribution(candidateWorkerSamples)
    };
  });
}

async function benchmarkColdStart(samples) {
  return withPrototypeEnvironment({}, async (env) => {
    const rawNodeSamples = [];
    const fileWorkerSamples = [];
    await spawnMeasured(["--eval", ""]);
    await runCandidate([coldStartFixture], env);
    for (let index = 0; index < samples; index += 1) {
      rawNodeSamples.push((await spawnMeasured(["--eval", ""])).durationMs);
      fileWorkerSamples.push((await runCandidate([coldStartFixture], env)).durationMs);
    }
    const rawNode = distribution(rawNodeSamples);
    const directFileWorker = distribution(fileWorkerSamples);
    return {
      samples,
      fixture: coldStartFixture,
      rawTopLevelNodeProcess: rawNode,
      directFileWorkerWithTestRunnerAndStructuredProof: directFileWorker,
      p95TestWorkerEnvelopeAboveRawNodeMs: roundMilliseconds(
        directFileWorker.p95Ms - rawNode.p95Ms
      )
    };
  });
}

async function runBaseline(files, env) {
  const timingRoot = mkdtempSync(path.join(tmpdir(), "ha-file-worker-baseline-"));
  try {
    return await spawnMeasured([
      "--test",
      `--test-concurrency=${concurrency}`,
      "--test-timeout=180000",
      `--test-reporter=${completionReporterUrl}`,
      "--test-reporter-destination=stdout",
      "--test-reporter=junit",
      `--test-reporter-destination=${path.join(timingRoot, "results.xml")}`,
      "--test-force-exit",
      ...files
    ], { env, fd3: true });
  } finally {
    rmSync(timingRoot, { recursive: true, force: true });
  }
}

async function runCandidate(files, env) {
  const junitRoot = mkdtempSync(path.join(tmpdir(), "ha-file-worker-candidate-"));
  try {
    const result = await runFileWorkerSchedule({
      files,
      concurrency,
      env,
      junitRoot,
      testTimeoutMs: 180_000,
      workerDeadlineMs: 180_000,
      proofExitGraceMs: 2_000
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
    return result;
  } finally {
    rmSync(junitRoot, { recursive: true, force: true });
  }
}

function spawnMeasured(args, { env = process.env, fd3 = false } = {}) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env,
    stdio: fd3
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolveRun, rejectRun) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (fd3) child.stdio[3].resume();
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      const durationMs = performance.now() - startedAt;
      if (code !== 0 || signal !== null) {
        rejectRun(new Error(
          `measured child failed code=${code} signal=${signal}\n${stdout}\n${stderr}`
        ));
        return;
      }
      resolveRun({ durationMs, code, signal });
    });
  });
}

function withPrototypeEnvironment(additions, run) {
  const baseEnv = {
    ...process.env,
    NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE
      ?? path.join(repoRoot, "node_modules/.cache/harness-node-compile"),
    HARNESS_ACTOR: process.env.HARNESS_ACTOR ?? "agent:harness-test",
    HARNESS_GIT_AUTHOR_NAME: process.env.HARNESS_GIT_AUTHOR_NAME ?? "Harness Test",
    HARNESS_GIT_AUTHOR_EMAIL: process.env.HARNESS_GIT_AUTHOR_EMAIL ?? "harness@example.test",
    ...additions
  };
  delete baseEnv.NODE_TEST_CONTEXT;
  const testEnvironment = createHermeticTestEnvironment(baseEnv);
  return Promise.resolve(run(testEnvironment.env)).finally(() => testEnvironment.cleanup());
}

function integrationEnvironment(baseEnv) {
  return {
    ...baseEnv,
    HARNESS_CLI_TEST_FIXTURE_PRELOAD: "1",
    NODE_OPTIONS: [baseEnv.NODE_OPTIONS, fixturePreload].filter(Boolean).join(" ")
  };
}

function comparisonSummary(baselineSamples, candidateSamples) {
  const baseline = distribution(baselineSamples);
  const candidate = distribution(candidateSamples);
  return {
    baseline,
    candidate,
    p95RegressionPercent: roundPercent(
      ((candidate.p95Ms / baseline.p95Ms) - 1) * 100
    )
  };
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minMs: roundMilliseconds(sorted[0]),
    p50Ms: roundMilliseconds(percentile(sorted, 0.5)),
    p95Ms: roundMilliseconds(percentile(sorted, 0.95)),
    maxMs: roundMilliseconds(sorted.at(-1)),
    meanMs: roundMilliseconds(values.reduce((sum, value) => sum + value, 0) / values.length)
  };
}

function percentile(sorted, quantile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function publicWorkerResult(worker) {
  return {
    id: worker.id,
    file: worker.file,
    outcome: worker.outcome,
    failure: worker.failure,
    proof: worker.proof,
    failures: worker.failures,
    close: worker.close,
    trace: worker.trace.map((event) => ({
      ...event,
      atMs: roundMilliseconds(event.atMs)
    })),
    stdout: worker.output.trim(),
    stderr: worker.errorOutput.trim()
  };
}

function assertTrace(trace, expectProof) {
  const phases = trace.map((event) => event.phase);
  assert.equal(phases[0], "spawn", JSON.stringify(trace));
  assert.equal(phases.at(-2), "close/reap", JSON.stringify(trace));
  assert.equal(phases.at(-1), "settled", JSON.stringify(trace));
  assert.equal(phases.includes("proof-flushed"), expectProof, JSON.stringify(trace));
  if (expectProof) {
    assert.equal(
      phases.indexOf("proof-flushed") < phases.indexOf("close/reap"),
      true,
      JSON.stringify(trace)
    );
  }
}

function parentSignalRecords(pidRoot) {
  return ["a", "b"]
    .map((label) => path.join(pidRoot, `${label}.json`))
    .filter(existsSync)
    .map((file) => JSON.parse(readFileSync(file, "utf8")));
}

function collectChild(child, timeoutMs) {
  return new Promise((resolveChild) => {
    let stdout = "";
    let stderr = "";
    let error = null;
    const deadline = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (caught) => {
      error = caught;
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolveChild({ code, signal, error, stdout, stderr });
    });
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`prototype condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function sampleCount(args) {
  const raw = args.find((argument) => argument.startsWith("--samples="));
  if (raw === undefined) return 20;
  const value = Number(raw.slice("--samples=".length));
  if (!Number.isSafeInteger(value) || value < 2) {
    throw new Error("--samples must be an integer of at least 2");
  }
  return value;
}

function runtimeEnvironment() {
  return {
    node: process.version,
    executable: process.execPath,
    platform: platform(),
    release: release(),
    architecture: arch(),
    logicalCpuCount: cpus().length
  };
}

function roundMilliseconds(value) {
  return Number(value.toFixed(3));
}

function roundPercent(value) {
  return Number(value.toFixed(2));
}
