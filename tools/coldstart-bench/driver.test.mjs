// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRunRecord } from "./driver.mjs";
import {
  prepareRunDirectory,
  reconcileEvidence,
  writeJson,
  writeJsonLines
} from "./evidence.mjs";
import { computeRunMetrics, detectContamination } from "./metrics.mjs";
import { validateRunRecord } from "./schema-validator.mjs";

const taskId = "task_01KZNZEVHKABC5HS5YQ29GQKKM";
const scenario = {
  schema: "coldstart-bench-scenario/v1",
  id: "task-create-coldstart/v1",
  prompt: "Create and read back one task.",
  theoreticalMinimumCommands: 2,
  commandOpportunities: [
    { id: "discover-help", command: "help", applicable: true, route: "primary" },
    { id: "discover-capabilities", command: "capabilities", applicable: true, route: "alternative" },
    { id: "task-create", command: "task.create", applicable: true, route: "primary" }
  ],
  verificationIds: ["task-package-present", "task-id-readback", "task-status-planned"]
};

const subjectActions = {
  schema: "coldstart-bench-subject-actions/v1",
  adapter: "scripted-json/v1",
  actionLogComplete: true,
  actions: [
    { id: "action-1", kind: "cli", argv: ["--help"] },
    { id: "action-2", kind: "cli", argv: ["capabilities"] },
    { id: "action-3", kind: "cli", argv: ["task", "create"] }
  ]
};

const invocations = [
  invocation("inv-1", "discover-help", "primary", ["--help"], false),
  invocation("inv-2", "discover-capabilities", "alternative", ["capabilities"], true),
  invocation("inv-3", "task-create", "primary", ["task", "create"], true)
];

const durableState = {
  schema: "coldstart-bench-durable-state/v1",
  task: { taskId, status: "planned" },
  checks: scenario.verificationIds.map((id) => ({ id, status: "passed", detail: `${id} passed` }))
};

test("driver metrics preserve explicit denominators and classify bypasses", () => {
  const measured = computeRunMetrics({ scenario, subjectActions, invocations, durableState });
  assert.deepEqual(measured.metrics.invocationRate, { numerator: 3, denominator: 3, value: 1 });
  assert.deepEqual(measured.metrics.firstAttemptCorrectRate, { numerator: 3, denominator: 3, value: 1 });
  assert.equal(measured.metrics.helpCalls, 1);
  assert.equal(measured.metrics.capabilitiesCalls, 1);
  assert.equal(measured.metrics.commandInflationRate, 1.5);
  assert.deepEqual(measured.metrics.bypassRate, { events: 0, totalActions: 3, rate: 0, categories: [] });
  assert.deepEqual(measured.metrics.alternativePathShare, { alternativeActions: 1, eligiblePathActions: 3, rate: 1 / 3 });

  const bypassed = computeRunMetrics({
    scenario,
    subjectActions: {
      ...subjectActions,
      actions: [...subjectActions.actions, { id: "action-4", kind: "shell", command: "sqlite3 .harness/projections.sqlite" }]
    },
    invocations,
    durableState
  });
  assert.equal(bypassed.metrics.bypassRate.events, 1);
  assert.deepEqual(bypassed.metrics.bypassRate.categories, ["sqlite-direct"]);
});

test("contamination detector marks evaluator reads and workspace leakage", () => {
  const evaluator = "/driver/tools/coldstart-bench/run.schema.json";
  assert.equal(detectContamination({ subjectActions, evaluatorPaths: [evaluator], evaluatorFilesPresentInWorkspace: false }).status, "clean");
  const readEvaluator = {
    ...subjectActions,
    actions: [...subjectActions.actions, { id: "action-4", kind: "read", path: evaluator }]
  };
  const detected = detectContamination({ subjectActions: readEvaluator, evaluatorPaths: [evaluator], evaluatorFilesPresentInWorkspace: false });
  assert.equal(detected.status, "contaminated");
  assert.deepEqual(detected.accessedEvaluatorFiles, [evaluator]);
  assert.equal(detectContamination({ subjectActions, evaluatorPaths: [], evaluatorFilesPresentInWorkspace: true }).status, "contaminated");
});

test("three-channel reconciliation is complete, then honestly incomplete when receipts are removed", () => {
  withEvidenceFixture((runDir) => {
    const complete = reconcileEvidence(runDir, scenario.verificationIds);
    assert.equal(complete.reconciliation.status, "complete");
    assert.equal(complete.reconciliation.productOutcome, "passed");
    assert.equal(complete.reconciliation.runtimeEventsUsedForVerdict, false);

    rmSync(path.join(runDir, "evidence/cli-receipts.jsonl"));
    const incomplete = reconcileEvidence(runDir, scenario.verificationIds);
    assert.equal(incomplete.reconciliation.status, "incomplete");
    assert.equal(incomplete.reconciliation.productOutcome, "unknown");
    assert.equal(incomplete.reconciliation.issues.includes("missing-required-channel:cliReceipts"), true);
  });
});

test("run schema accepts a complete record and rejects missing contract fields", () => {
  withEvidenceFixture((runDir) => {
    const measured = computeRunMetrics({ scenario, subjectActions, invocations, durableState });
    const reconciled = reconcileEvidence(runDir, scenario.verificationIds);
    const contamination = detectContamination({ subjectActions, evaluatorPaths: [], evaluatorFilesPresentInWorkspace: false });
    const run = buildRunRecord({
      seed: 104729,
      scenario: measured.scenario,
      scenarioBody: JSON.stringify(scenario),
      subjectActions,
      contamination,
      metrics: measured.metrics,
      evidence: reconciled.evidence,
      reconciliation: reconciled.reconciliation,
      fixtureSetup: fixtureSetup(),
      cleanup: { daemonStopped: true, worktreeRemoved: true, baseRemoved: true, errors: [] },
      control: { kind: "primary", sourceRunId: null, omittedChannel: null },
      runId: "coldstart-contract-fixture",
      recordedAt: "2026-08-10T00:00:00.000Z",
      inheritedProvenance: {
        sourceCommit: "a".repeat(40),
        sourceDirty: false,
        buildHash: `sha256:${"b".repeat(64)}`,
        buildArtifact: "packages/cli/dist/cli/src/index.js",
        runner: { name: "coldstart-bench-driver", version: "1.0.0" },
        schema: { version: "coldstart-eval-run/v1", hash: `sha256:${"c".repeat(64)}` },
        scenarioHash: `sha256:${"d".repeat(64)}`,
        promptHash: `sha256:${"e".repeat(64)}`
      }
    });
    assert.deepEqual(validateRunRecord(run), { ok: true, errors: [] });

    const missingPromptHash = structuredClone(run);
    delete missingPromptHash.provenance.promptHash;
    const invalid = validateRunRecord(missingPromptHash);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors.some((error) => error.includes("promptHash")), true);
  });
});

function withEvidenceFixture(assertions) {
  const parent = mkdtempSync(path.join(tmpdir(), "coldstart-bench-unit-"));
  const runDir = path.join(parent, "run");
  try {
    prepareRunDirectory(runDir);
    writeJsonLines(path.join(runDir, "evidence/driver-invocations.jsonl"), invocations);
    writeJsonLines(path.join(runDir, "evidence/cli-receipts.jsonl"), invocations.map((row) => ({
      invocationId: row.invocationId,
      opportunityId: row.opportunityId,
      receiptExpected: row.receiptExpected,
      parseStatus: row.receiptExpected ? "parsed" : "not-applicable",
      receipt: row.opportunityId === "task-create" ? { ok: true, taskId } : row.receiptExpected ? { ok: true } : null
    })));
    writeJson(path.join(runDir, "evidence/durable-state.json"), durableState);
    writeJson(path.join(runDir, "evidence/subject-actions.json"), subjectActions);
    writeJson(path.join(runDir, "evidence/runtime-events.json"), { totalRecords: 0 });
    writeJson(path.join(runDir, "evidence/fixture-setup.json"), fixtureSetup());
    assertions(runDir);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function invocation(invocationId, opportunityId, route, argv, receiptExpected) {
  return {
    invocationId,
    opportunityId,
    route,
    argv,
    exitCode: 0,
    receiptExpected,
    receiptParsed: receiptExpected
  };
}

function fixtureSetup() {
  return {
    schema: "coldstart-bench-fixture-setup/v1",
    workspaceKind: "git-worktree",
    daemonNamespace: "coldstart-unit",
    daemonUserRootExternal: true,
    evaluatorFiles: [],
    records: []
  };
}
