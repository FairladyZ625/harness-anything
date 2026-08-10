#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashBytes,
  hashFile,
  prepareRunDirectory,
  reconcileEvidence,
  sealRunDirectory,
  writeJson,
  writeJsonLines
} from "./evidence.mjs";
import {
  captureDurableState,
  cleanupFixture,
  cliEntry,
  cliEntryRelative,
  collectRuntimeEventSummary,
  createIsolatedFixture,
  evaluatorPaths,
  prepareFixture,
  repositoryRoot,
  runCli,
  runSubjectPlan,
  sourceMetadata
} from "./fixture.mjs";
import { computeRunMetrics, detectContamination } from "./metrics.mjs";
import {
  assertValidRunRecord,
  RUNNER_VERSION,
  RUN_SCHEMA_VERSION,
  runSchemaPath
} from "./schema-validator.mjs";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultScenarioPath = path.join(moduleRoot, "scenarios/task-create.json");
const defaultSubjectScript = path.join(moduleRoot, "fake-subject.mjs");

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = runColdstartBench(parseOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export function runColdstartBench(options) {
  prepareRunDirectory(options.runDir);
  const scenarioBody = readFileSync(options.scenarioPath, "utf8");
  const scenario = JSON.parse(scenarioBody);
  validateScenario(scenario);
  const fixture = createIsolatedFixture(options.seed);
  let cleanup = { daemonStopped: false, worktreeRemoved: false, baseRemoved: false, errors: ["cleanup-not-attempted"] };
  try {
    const fixtureSetup = prepareFixture(fixture);
    const subjectActions = runSubjectPlan(fixture, options.subjectScript);
    const contamination = detectContamination({
      subjectActions,
      evaluatorPaths: evaluatorPaths(),
      evaluatorFilesPresentInWorkspace: fixtureSetup.evaluatorFiles.length > 0
    });
    const { invocations, receipts } = executeSubjectActions(fixture, subjectActions);
    const taskId = deepString(receipts.find((row) => row.opportunityId === "task-create")?.receipt, "taskId");
    if (!taskId) throw new Error("scripted subject did not produce a task id; refusing to fabricate durable-state evidence");
    const durableState = captureDurableState(fixture, taskId);
    const runtimeEvents = collectRuntimeEventSummary(fixture);

    writeJsonLines(path.join(options.runDir, "evidence/driver-invocations.jsonl"), invocations);
    writeJsonLines(path.join(options.runDir, "evidence/cli-receipts.jsonl"), receipts);
    writeJson(path.join(options.runDir, "evidence/durable-state.json"), durableState);
    writeJson(path.join(options.runDir, "evidence/subject-actions.json"), subjectActions);
    writeJson(path.join(options.runDir, "evidence/runtime-events.json"), runtimeEvents);
    writeJson(path.join(options.runDir, "evidence/fixture-setup.json"), fixtureSetup);

    const measured = computeRunMetrics({ scenario, subjectActions, invocations, durableState });
    const reconciled = reconcileEvidence(options.runDir, scenario.verificationIds);
    cleanup = cleanupFixture(fixture);
    const run = buildRunRecord({
      seed: options.seed,
      scenario: measured.scenario,
      scenarioBody,
      subjectActions,
      contamination,
      metrics: measured.metrics,
      evidence: reconciled.evidence,
      reconciliation: reconciled.reconciliation,
      fixtureSetup,
      cleanup,
      control: { kind: "primary", sourceRunId: null, omittedChannel: null }
    });
    assertValidRunRecord(run);
    writeJson(path.join(options.runDir, "run.json"), run);
    sealRunDirectory(options.runDir);
    return {
      ok: run.status === "complete" && run.outcome === "passed" && run.validity.status === "valid",
      runId: run.runId,
      runRecord: path.join(options.runDir, "run.json"),
      status: run.status,
      outcome: run.outcome,
      validity: run.validity.status,
      reconciliationIssues: run.reconciliation.issues
    };
  } catch (error) {
    if (!cleanup.baseRemoved) cleanup = cleanupFixture(fixture);
    throw new Error(`cold-start bench failed; cleanup=${JSON.stringify(cleanup)}; cause=${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

export function buildRunRecord({
  seed,
  scenario,
  scenarioBody,
  subjectActions,
  contamination,
  metrics,
  evidence,
  reconciliation,
  fixtureSetup,
  cleanup,
  control,
  runId = createRunId(seed),
  recordedAt = new Date().toISOString(),
  inheritedProvenance
}) {
  const provenance = inheritedProvenance ?? {
    ...sourceMetadata(),
    buildHash: hashFile(cliEntry),
    buildArtifact: cliEntryRelative,
    runner: { name: "coldstart-bench-driver", version: RUNNER_VERSION },
    schema: { version: RUN_SCHEMA_VERSION, hash: hashFile(runSchemaPath) },
    scenarioHash: hashBytes(scenarioBody),
    promptHash: hashBytes(scenario.prompt)
  };
  const status = reconciliation.status;
  const validityReasons = [];
  if (status !== "complete") validityReasons.push("evidence-incomplete");
  if (contamination.status !== "clean") validityReasons.push("subject-contaminated");
  if (!subjectActions.actionLogComplete) validityReasons.push("subject-action-log-incomplete");
  if (fixtureSetup.evaluatorFiles.length > 0) validityReasons.push("evaluator-files-present-in-workspace");
  if (cleanup.errors.length > 0) validityReasons.push("fixture-cleanup-failed");
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId,
    recordedAt,
    appendOnly: true,
    status,
    outcome: status === "complete" ? reconciliation.productOutcome : "unknown",
    control,
    provenance,
    subject: {
      adapter: subjectActions.adapter,
      provider: "scripted",
      model: "fake-subject",
      modelVersion: "1",
      actionLogComplete: subjectActions.actionLogComplete
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown",
      daemonMode: "local",
      daemonNamespace: fixtureSetup.daemonNamespace,
      workspaceKind: fixtureSetup.workspaceKind,
      workspaceEvaluatorFilesPresent: fixtureSetup.evaluatorFiles.length > 0,
      daemonUserRootExternal: fixtureSetup.daemonUserRootExternal,
      cleanup
    },
    randomSeed: seed,
    scenario,
    contamination,
    metrics,
    evidence,
    reconciliation,
    validity: {
      status: validityReasons.length === 0 ? "valid" : "invalid",
      reasons: validityReasons
    }
  };
}

function executeSubjectActions(fixture, subjectActions) {
  const invocations = [];
  const receipts = [];
  let sequence = 0;
  for (const action of subjectActions.actions) {
    if (action.kind !== "cli") continue;
    sequence += 1;
    const invocationId = `inv-${String(sequence).padStart(4, "0")}`;
    const result = runCli(fixture, action.argv);
    const receiptParsed = result.receipt !== null;
    invocations.push({
      invocationId,
      actionId: action.id,
      sequence,
      opportunityId: action.opportunityId ?? null,
      route: action.route ?? null,
      argv: action.argv,
      commandLine: result.commandLine,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      receiptExpected: action.receiptExpected === true,
      receiptParsed,
      stdoutHash: hashBytes(result.stdout),
      stderrHash: hashBytes(result.stderr)
    });
    receipts.push({
      invocationId,
      actionId: action.id,
      opportunityId: action.opportunityId ?? null,
      receiptExpected: action.receiptExpected === true,
      parseStatus: action.receiptExpected === true ? receiptParsed ? "parsed" : "missing" : "not-applicable",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      receipt: result.receipt
    });
  }
  return { invocations, receipts };
}

function parseOptions(args) {
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const runDir = option("--run-dir");
  if (!runDir) throw new Error("Usage: node tools/coldstart-bench/driver.mjs --run-dir <absolute-path> [--seed <integer>] [--scenario <file>] [--subject-script <file>]");
  const seed = Number(option("--seed", "104729"));
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative safe integer");
  return {
    runDir: path.resolve(runDir),
    seed,
    scenarioPath: path.resolve(option("--scenario", defaultScenarioPath)),
    subjectScript: path.resolve(option("--subject-script", defaultSubjectScript))
  };
}

function validateScenario(scenario) {
  if (scenario?.schema !== "coldstart-bench-scenario/v1" || typeof scenario.id !== "string" || typeof scenario.prompt !== "string") {
    throw new Error("scenario must be a coldstart-bench-scenario/v1 document");
  }
  if (!Number.isSafeInteger(scenario.theoreticalMinimumCommands) || scenario.theoreticalMinimumCommands < 1) {
    throw new Error("scenario.theoreticalMinimumCommands must be a positive integer");
  }
  if (!Array.isArray(scenario.commandOpportunities) || scenario.commandOpportunities.filter((row) => row.applicable).length < 1) {
    throw new Error("scenario must declare at least one applicable command opportunity");
  }
  if (!Array.isArray(scenario.verificationIds) || scenario.verificationIds.length < 1) {
    throw new Error("scenario must declare driver verification ids");
  }
}

function createRunId(seed) {
  return `coldstart-${new Date().toISOString().replaceAll(/[-:.]/gu, "")}-${String(seed)}-${randomUUID().slice(0, 8)}`;
}

function deepString(root, key) {
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (typeof value[key] === "string") return value[key];
    for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
  }
  return null;
}

export const coldstartBenchPaths = Object.freeze({
  repositoryRoot,
  defaultScenarioPath,
  defaultSubjectScript,
  platform: os.platform()
});
