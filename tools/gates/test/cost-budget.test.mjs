// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  evaluateCostBudget,
  evaluateCollectionCosts,
  evaluateG1WriteCostScaling,
  G1_OPERATION_NAMES,
  measureCosts,
  measureG1WriteCostScaling,
  readCostFixture,
} from "../cost-budget.mjs";
import {
  measureTaskSubmitArtifacts,
  measureDocuments,
  measureRelations,
  measureAssignmentHistory,
  measureCatalogBatch,
  measureEntityPins,
  measureTaskReviewDispatchBatch,
  measureTaskAmendPatches,
  assertTaskReviewDispatchMeasurement,
  measureTaskWitnessGates,
  COLLECTION_SCALES,
  COLLECTION_PROBES,
} from "../../../packages/daemon/test/fixtures/g38-collection-cost.mjs";
import {
  measureTaskReviewConsent,
  measureTaskReviewExecution,
  measureTaskReviewResponses,
} from "../../../packages/daemon/test/fixtures/g38-lifecycle-cost.mjs";
import { measureWorktreeDocuments } from "../../../packages/daemon/test/fixtures/g38-worktree-document-cost.mjs";
import { signReceipt } from "../receipt-verify.mjs";
import {
  DECISION_PROBES,
  measureDecisionCollection,
} from "../../../packages/daemon/test/fixtures/g38-decision-cost.mjs";

function fixture() {
  return JSON.parse(
    readFileSync(new URL("../../../packages/daemon/fixtures/perf/cost-budget-ledger.json", import.meta.url), "utf8"),
  );
}

function setup(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-cost-budget-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(path.join(rootDir, "tools/gates/receipts"), { recursive: true });
  writeFileSync(path.join(rootDir, "fixture.json"), `${JSON.stringify(fixture())}\n`);
  writeFileSync(
    path.join(rootDir, "tools/gates/cost-budget.json"),
    `${JSON.stringify({
      schema: "cost-budget/v1",
      fixture: "fixture.json",
      baseline: { projectionRebuildGitProcesses: 4 },
      budgets: { projectionRebuildGitProcesses: 4 },
    })}\n`,
  );
  return rootDir;
}

test("G38 measures the production rebuild counter", async (t) => {
  assert.deepEqual(await measureCosts(readCostFixture(path.join(setup(t), "fixture.json"))), {
    // Rebuild reads the accepting SQLite ledger; it no longer spawns Git.
    projectionRebuildGitProcesses: 0,
  });
});

test("G38 passes at the committed ceiling", async (t) => {
  const rootDir = setup(t);
  assert.equal((await evaluateCostBudget({ rootDir })).ok, true);
});

test("G38 requires a signed receipt for a budget increase", async (t) => {
  const rootDir = setup(t);
  const budgetPath = path.join(rootDir, "tools/gates/cost-budget.json");
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  budget.budgets.projectionRebuildGitProcesses = 5;
  writeFileSync(budgetPath, `${JSON.stringify(budget)}\n`);
  assert.match((await evaluateCostBudget({ rootDir })).errors.join("\n"), /without a valid cost-budget receipt/u);
  const unsigned = {
    decisionId: "dec_01KZQ92VEPTDRS2HS8CKDBKW2Q",
    scope: "cost:projectionRebuildGitProcesses",
    kind: "cost-budget",
    limit: 5,
    expiry: "2099-12-31T23:59:59Z",
  };
  writeFileSync(
    path.join(rootDir, "tools/gates/receipts/cost.json"),
    `${JSON.stringify({ ...unsigned, signature: signReceipt(unsigned) })}\n`,
  );
  assert.equal((await evaluateCostBudget({ rootDir })).ok, true);
});

// --- G1 write-path scale invariant ------------------------------------------------------------

const G1_OPS = Object.freeze(["op-a"]);
const G1_TEST_METRICS = Object.freeze(["sqlRowsRead", "gitProcesses"]);

function g1Setup(t, { baseline = { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } }, knownScaling = [] } = {}) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-g1-cost-budget-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(path.join(rootDir, "tools/gates/receipts"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "tools/gates/cost-budget.json"),
    `${JSON.stringify({
      writeCostScaling: {
        schema: "write-cost-scaling-budget/v1",
        scales: { small: 200, large: 2000 },
        baseline,
        budgets: baseline,
        knownScaling,
        actionCoverage: {
          measured: { "op-a": { measurements: ["op-a:ledger-events"] } },
          notApplicable: [{ actions: ["op-b"], reason: "The test fixture action has no measured collection loop." }],
        },
      },
    })}\n`,
  );
  mkdirSync(path.join(rootDir, "packages/kernel/src/domain"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "packages/kernel/src/domain/entity-kind-registry.ts"),
    "export const entityKindContracts = [];\n",
  );
  writeFileSync(
    path.join(rootDir, "packages/kernel/src/domain/action-declaration.ts"),
    "export const actionDeclarations = [" +
      "{ kind: 'op-a', executionClass: 'repo-write', residency: { scope: 'canonical' } }," +
      "{ kind: 'op-b', executionClass: 'repo-write', residency: { scope: 'canonical' } }];" +
      "export const artifactActionIngressKinds = [];\n",
  );
  return rootDir;
}

function g1Measured(small, large, { operations = G1_OPS, metrics = G1_TEST_METRICS } = {}) {
  return { small: { counts: small }, large: { counts: large }, operations, metrics };
}

test("G1 passes when the 2000-scale count stays within the fixed margin of the 200-scale count", async (t) => {
  const rootDir = g1Setup(t);
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    { "op-a": { sqlRowsRead: 105, gitProcesses: 4 } },
  );
  const result = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("G1 rejects an unexempted operation whose count grows with ledger scale", async (t) => {
  const rootDir = g1Setup(t);
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    { "op-a": { sqlRowsRead: 900, gitProcesses: 4 } },
  );
  const result = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /op-a\.sqlRowsRead: measured 100 at 200 events grew to 900 at 2000 events.*no knownScaling exemption/u,
  );
});

test("G1 tolerates a growing count when a live knownScaling exemption names the exact pair", async (t) => {
  const rootDir = g1Setup(t, {
    baseline: { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    knownScaling: [
      {
        operation: "op-a",
        metric: "sqlRowsRead",
        reason: "test fixture for a pre-existing O(N) read this task did not fix",
        deletionTaskId: "task_test_deletion_batch",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
  });
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    { "op-a": { sqlRowsRead: 900, gitProcesses: 4 } },
  );
  const result = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("G1 fails a growing count guarded by an expired knownScaling exemption", async (t) => {
  const rootDir = g1Setup(t, {
    baseline: { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    knownScaling: [
      {
        operation: "op-a",
        metric: "sqlRowsRead",
        reason: "test fixture for an exemption that ran out",
        deletionTaskId: "task_test_deletion_batch",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    ],
  });
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    { "op-a": { sqlRowsRead: 900, gitProcesses: 4 } },
  );
  const result = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /op-a\.sqlRowsRead: knownScaling exemption expired/u);
});

test("G1 fails a stale knownScaling exemption whose pair no longer grows", async (t) => {
  const rootDir = g1Setup(t, {
    baseline: { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    knownScaling: [
      {
        operation: "op-a",
        metric: "sqlRowsRead",
        reason: "test fixture for an exemption the fix already made unnecessary",
        deletionTaskId: "task_test_deletion_batch",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
  });
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    { "op-a": { sqlRowsRead: 105, gitProcesses: 4 } },
  );
  const result = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /op-a\.sqlRowsRead: knownScaling exemption is stale/u);
});

test("G1 rejects a 200-scale measurement that exceeds the committed budget", async (t) => {
  const rootDir = g1Setup(t);
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 150, gitProcesses: 4 } },
    { "op-a": { sqlRowsRead: 155, gitProcesses: 4 } },
  );
  const result = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /op-a\.sqlRowsRead: measured 150 at 200 events exceeds budget 100/u);
});

test("G1 requires a signed receipt to raise a committed budget above baseline", async (t) => {
  const rootDir = g1Setup(t);
  const budgetPath = path.join(rootDir, "tools/gates/cost-budget.json");
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  budget.writeCostScaling.budgets["op-a"].sqlRowsRead = 150;
  writeFileSync(budgetPath, `${JSON.stringify(budget)}\n`);
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 140, gitProcesses: 4 } },
    { "op-a": { sqlRowsRead: 145, gitProcesses: 4 } },
  );
  const withoutReceipt = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(withoutReceipt.ok, false);
  assert.match(withoutReceipt.errors.join("\n"), /without a valid g1-cost-budget receipt/u);
  const unsigned = {
    decisionId: "dec_01KZQ92VEPTDRS2HS8CKDBKW2Q",
    scope: "cost:g1:op-a:sqlRowsRead",
    kind: "g1-cost-budget",
    limit: 150,
    expiry: "2099-12-31T23:59:59Z",
  };
  writeFileSync(
    path.join(rootDir, "tools/gates/receipts/g1-cost.json"),
    `${JSON.stringify({ ...unsigned, signature: signReceipt(unsigned) })}\n`,
  );
  const withReceipt = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(withReceipt.ok, true, JSON.stringify(withReceipt.errors));
});

test("G1 measures the two ledger scales one after the other", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-g1-sequential-")),
    fixtureDir = path.join(rootDir, "packages/daemon/test/fixtures");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(fixtureDir, { recursive: true });
  // Each fake measurement yields mid-flight; overlapping scales would record a second start first.
  writeFileSync(
    path.join(fixtureDir, "g1-write-cost-scaling.ts"),
    [
      "export const G1_OPERATIONS = ['op-a'];",
      "export const G1_METRICS = ['sqlRowsRead'];",
      "export const events = [];",
      "export async function measureWriteCostScaling(eventCount) {",
      "  events.push(`start:${eventCount}`);",
      "  await new Promise((resolve) => setTimeout(resolve, 5));",
      "  events.push(`end:${eventCount}`);",
      "  return { eventCount, counts: { 'op-a': { sqlRowsRead: eventCount } } };",
      "}",
      "",
    ].join("\n"),
  );
  const measured = await measureG1WriteCostScaling(rootDir, { small: 200, large: 2000 });
  const { events } = await import(pathToFileURL(path.join(fixtureDir, "g1-write-cost-scaling.ts")).href);
  assert.deepEqual(events, ["start:200", "end:200", "start:2000", "end:2000"]);
  assert.deepEqual([measured.small.eventCount, measured.large.eventCount], [200, 2000]);
});

test("G1 rejects a budget file missing an operation the measurement covers", async (t) => {
  const rootDir = g1Setup(t);
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 100, gitProcesses: 4 }, "op-b": { sqlRowsRead: 10, gitProcesses: 0 } },
    { "op-a": { sqlRowsRead: 105, gitProcesses: 4 }, "op-b": { sqlRowsRead: 10, gitProcesses: 0 } },
    { operations: ["op-a", "op-b"] },
  );
  await assert.rejects(
    evaluateG1WriteCostScaling({ rootDir, measured }),
    /writeCostScaling\.baseline is missing operation op-b/u,
  );
});

test("G1 operation names are exactly the committed baseline's operations, the list the PR body lint accepts", () => {
  const committed = JSON.parse(readFileSync(new URL("../cost-budget.json", import.meta.url), "utf8"));
  assert.deepEqual(G1_OPERATION_NAMES, Object.keys(committed.writeCostScaling.baseline));
  assert.ok(G1_OPERATION_NAMES.includes("agenda"));
  assert.ok(Object.isFrozen(G1_OPERATION_NAMES));
});

test("G38 requires every canonical write action to have a measured operation or a reason", async (t) => {
  const rootDir = g1Setup(t),
    budgetPath = path.join(rootDir, "tools/gates/cost-budget.json"),
    budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  budget.writeCostScaling.actionCoverage.notApplicable = [];
  writeFileSync(budgetPath, `${JSON.stringify(budget)}\n`);
  await assert.rejects(
    evaluateG1WriteCostScaling({
      rootDir,
      measured: g1Measured(
        { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
        { "op-a": { sqlRowsRead: 105, gitProcesses: 4 } },
      ),
    }),
    /actionCoverage is missing canonical write actions: op-b/u,
  );
});

test("G38 rejects an action directory addition without a same-file coverage declaration", async (t) => {
  const rootDir = g1Setup(t),
    declarationPath = path.join(rootDir, "packages/kernel/src/domain/action-declaration.ts");
  writeFileSync(
    declarationPath,
    "export const actionDeclarations = [" +
      "{ kind: 'op-a', executionClass: 'repo-write', residency: { scope: 'canonical' } }," +
      "{ kind: 'op-b', executionClass: 'repo-write', residency: { scope: 'canonical' } }," +
      "{ kind: 'op-c', executionClass: 'repo-write', residency: { scope: 'canonical' } }];" +
      "export const artifactActionIngressKinds = [];\n",
  );
  await assert.rejects(
    evaluateG1WriteCostScaling({
      rootDir,
      measured: g1Measured(
        { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
        { "op-a": { sqlRowsRead: 105, gitProcesses: 4 } },
      ),
    }),
    /actionCoverage is missing canonical write actions: op-c/u,
  );
});

test("coverage cannot bind another action's probe or exempt an action without a reason", async (t) => {
  const rootDir = g1Setup(t),
    budgetPath = path.join(rootDir, "tools/gates/cost-budget.json"),
    budget = JSON.parse(readFileSync(budgetPath, "utf8")),
    measured = g1Measured(
      { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
      { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    );
  budget.writeCostScaling.actionCoverage.measured["op-a"].measurements = ["task-submit:task-artifacts"];
  writeFileSync(budgetPath, JSON.stringify(budget));
  await assert.rejects(evaluateG1WriteCostScaling({ rootDir, measured }), /no matching production measurement/u);
  budget.writeCostScaling.actionCoverage.measured["op-a"].measurements = ["op-a:ledger-events"];
  budget.writeCostScaling.actionCoverage.notApplicable[0].reason = "   ";
  writeFileSync(budgetPath, JSON.stringify(budget));
  await assert.rejects(evaluateG1WriteCostScaling({ rootDir, measured }), /reason is required/u);
});

test("coverage discovers a newly added artifact ingress and ignores host-local and read actions", async (t) => {
  const rootDir = g1Setup(t),
    declarationPath = path.join(rootDir, "packages/kernel/src/domain/action-declaration.ts"),
    measured = g1Measured(
      { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
      { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    );
  assert.equal((await evaluateG1WriteCostScaling({ rootDir, measured })).ok, true);
  writeFileSync(
    declarationPath,
    readFileSync(declarationPath, "utf8")
      .replace(
        "export const artifactActionIngressKinds = [];",
        "export const artifactActionIngressKinds = ['artifact-new'];",
      )
      .replace(
        "{ kind: 'op-b'",
        "{kind:'local', executionClass:'repo-write',residency:{scope:'host-local'}},{kind:'query',executionClass:'repo-read',residency:{scope:'canonical'}},{ kind: 'op-b'",
      ),
  );
  await assert.rejects(
    evaluateG1WriteCostScaling({ rootDir, measured }),
    /missing canonical write actions: artifact-new$/u,
  );
});

test("task-submit scaling measures the production orchestration and one acceptance index", async () => {
  const measured = {
    small: await measureTaskSubmitArtifacts(process.cwd(), 100),
    large: await measureTaskSubmitArtifacts(process.cwd(), 2000),
  };
  assert.deepEqual([measured.small.counts.acceptanceReads, measured.large.counts.acceptanceReads], [1, 1]);
  for (const value of Object.values(measured)) {
    assert.equal(value.counts.claimsExamined, value.size);
    assert.equal(value.counts.blobReads, value.size);
  }
  assert.equal(evaluateCollectionCosts({ submit: measured }).ok, true);
});

test("a constant-growth probe rejects writer-held work that grows with the collection", () => {
  const linear = {
      small: { size: 100, counts: { captureCopiedFiles: 101 } },
      large: { size: 2000, counts: { captureCopiedFiles: 2001 } },
    },
    result = evaluateCollectionCosts({
      "schedule-run-now:unchanged-ledger-files": { ...linear, growth: "constant" },
    });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /101 at 100 grew to 2001 at 2000 .*constant-cost limit/u);
  // The same counts pass the default linear rule, which is why the backup probe declares constant growth.
  assert.equal(evaluateCollectionCosts({ "linear:probe": linear }).ok, true);
});

test("the scheduled backup capture copies only changed ledger files while the writer is held", async () => {
  const probe = COLLECTION_PROBES["schedule-run-now:unchanged-ledger-files"],
    measured = {
      small: await probe.run(process.cwd(), COLLECTION_SCALES.small),
      large: await probe.run(process.cwd(), COLLECTION_SCALES.large),
      growth: probe.growth,
    };
  assert.equal(probe.growth, "constant");
  assert.deepEqual([measured.small.counts.captureCopiedFiles, measured.large.counts.captureCopiedFiles], [1, 1]);
  assert.deepEqual(evaluateCollectionCosts({ "schedule-run-now:unchanged-ledger-files": measured }).errors, []);
});

test("task-witness-run scans the selected execution's frozen gate collection linearly", async () => {
  const measured = {
    small: await measureTaskWitnessGates(process.cwd(), 100),
    large: await measureTaskWitnessGates(process.cwd(), 2000),
  };
  assert.deepEqual([measured.small.counts.gateMembersRead, measured.large.counts.gateMembersRead], [200, 4000]);
  assert.equal(evaluateCollectionCosts({ "task-witness-run:frozen-gates": measured }).ok, true);
});

test("task review response probe indexes prior responses and findings once", async () => {
  const measured = {
      small: await measureTaskReviewResponses(process.cwd(), 100),
      large: await measureTaskReviewResponses(process.cwd(), 2000),
    },
    result = evaluateCollectionCosts({ "task-respond-review:responses": measured });
  assert.deepEqual(
    [measured.small.counts.priorResponsesExamined, measured.large.counts.priorResponsesExamined],
    [100, 2000],
  );
  assert.deepEqual([measured.small.counts.findingsExamined, measured.large.counts.findingsExamined], [100, 2000]);
  assert.deepEqual(result.errors, []);
});

test("coverage includes canonical entity catalog writers without a public permission declaration", async (t) => {
  const rootDir = g1Setup(t),
    measured = g1Measured(
      { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
      { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    );
  writeFileSync(
    path.join(rootDir, "packages/kernel/src/domain/entity-kind-registry.ts"),
    "export const entityKindContracts = [{residency:{authored:'ledger'},actionCatalog:{actions:[{execution:{ingress:'internal-event',read:false}}]}}];\n",
  );
  await assert.rejects(
    evaluateG1WriteCostScaling({ rootDir, measured }),
    /missing canonical write actions: internal-event/u,
  );
});

test("collection scaling rejects quadratic claims work despite a linear acceptance count", () => {
  const result = evaluateCollectionCosts({
    submit: {
      small: { size: 100, counts: { acceptanceReads: 100, claimsExamined: 5050 } },
      large: { size: 2000, counts: { acceptanceReads: 2000, claimsExamined: 2001000 } },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /claimsExamined: 5050 at 100 grew to 2001000 at 2000/u);
});

test("linear batch work with a constant subtraction passes but 20% per-item growth fails", () => {
  for (const [small, large, ok] of [
    [899, 17999, true],
    [100, 2400, false],
  ])
    assert.equal(
      evaluateCollectionCosts({
        batch: {
          small: { size: 100, counts: { hashes: small } },
          large: { size: 2000, counts: { hashes: large } },
        },
      }).ok,
      ok,
    );
});

test("document counts, event body bytes, and a paged single-owner relation collection stay linear", async () => {
  for (const run of [measureDocuments, (root, n) => measureDocuments(root, 1, n), measureRelations]) {
    const measured = { probe: { small: await run(process.cwd(), 100), large: await run(process.cwd(), 2000) } };
    assert.deepEqual(evaluateCollectionCosts(measured).errors, []);
  }
});

test("runtime-run dispatch admission measures both declared execution scales", async () => {
  const probe = COLLECTION_PROBES["runtime-run:execution-dispatches"];
  assert.ok(probe, "runtime-run execution dispatch probe must remain registered");
  const measured = {
    small: await probe.run(process.cwd(), COLLECTION_SCALES.small),
    large: await probe.run(process.cwd(), COLLECTION_SCALES.large),
  };
  assert.deepEqual([measured.small.size, measured.large.size], [100, 2000]);
  assert.deepEqual(
    [measured.small.counts.dispatchRowsExamined, measured.large.counts.dispatchRowsExamined],
    [100, 2000],
  );
  assert.deepEqual(evaluateCollectionCosts({ "runtime-run:execution-dispatches": measured }).errors, []);
});

test("collection cost rejects zero baselines growing positive, mismatched metrics and invalid scales", () => {
  assert.throws(() => evaluateCollectionCosts({}), /must not be empty/u);
  assert.equal(
    evaluateCollectionCosts({
      p: { small: { size: 100, counts: { rows: 0 } }, large: { size: 2000, counts: { rows: 1 } } },
    }).ok,
    false,
  );
  assert.equal(
    evaluateCollectionCosts({
      p: { small: { size: 100, counts: { rows: 0 } }, large: { size: 2000, counts: { rows: 0 } } },
    }).ok,
    true,
  );
  for (const [small, large] of [
    [0, 2],
    [-1, 2],
    [1, 1],
    [2, 1],
    [1.5, 2],
  ])
    assert.throws(
      () => evaluateCollectionCosts({ p: { small: { size: small }, large: { size: large } } }),
      /collection scales/u,
    );
  assert.throws(
    () => evaluateCollectionCosts({ p: { small: { size: 1, counts: { rows: 1 } }, large: { size: 2, counts: {} } } }),
    /same nonempty metric set/u,
  );
});

test("every assignment ingress measures one subject's retired history through its production executor", async () => {
  const assignments = Object.values(COLLECTION_PROBES).filter(({ dimension }) => dimension === "assignment-history");
  assert.equal(assignments.length, 12);
  for (const { action } of assignments) {
    const probe = {
      small: await measureAssignmentHistory(process.cwd(), 100, action),
      large: await measureAssignmentHistory(process.cwd(), 2000, action),
    };
    assert.deepEqual(evaluateCollectionCosts({ [action]: probe }).errors, []);
  }
});

test("repin-all and fact archive publish every member at both collection scales", async () => {
  for (const action of ["decision-repin", "fact-archive"]) {
    const probe = {
      small: await measureCatalogBatch(process.cwd(), 100, action),
      large: await measureCatalogBatch(process.cwd(), 2000, action),
    };
    assert.deepEqual(evaluateCollectionCosts({ [action]: probe }).errors, []);
  }
});

test("Decision writes compile their actual publication against one entity's growing claims", async () => {
  assert.ok(Object.keys(DECISION_PROBES).length > 0);
  for (const [id, { run }] of Object.entries(DECISION_PROBES)) {
    const small = await run(process.cwd(), 100),
      large = await run(process.cwd(), 2000);
    assert.ok(small.counts.membersExamined >= 100, id);
    assert.deepEqual(evaluateCollectionCosts({ [id]: { small, large } }).errors, [], id);
  }
});

test("Decision review responses scan finding collections linearly in the production compiler", async () => {
  const small = await measureDecisionCollection(process.cwd(), 100, "decision-respond-review", "review-findings"),
    large = await measureDecisionCollection(process.cwd(), 2000, "decision-respond-review", "review-findings"),
    result = evaluateCollectionCosts({ "decision-respond-review:review-findings": { small, large } });
  assert.equal(small.counts.membersExamined, 202);
  assert.equal(large.counts.membersExamined, 4002);
  assert.deepEqual(result.errors, []);
});

test("pin and unpin scale with the real repository pin collection", async () => {
  for (const action of ["entity-pin", "entity-unpin"]) {
    const measured = {
      small: await measureEntityPins(process.cwd(), 100, action),
      large: await measureEntityPins(process.cwd(), 2000, action),
    };
    assert.deepEqual(evaluateCollectionCosts({ [action]: measured }).errors, []);
  }
});

test("task review dispatch batch scales with the supplied task id collection", async () => {
  const measured = {
    small: await measureTaskReviewDispatchBatch(process.cwd(), 100),
    large: await measureTaskReviewDispatchBatch(process.cwd(), 2000),
  };
  assert.deepEqual(evaluateCollectionCosts({ "task-dispatch-review:task-ids": measured }).errors, []);
});

test("task review dispatch measurement rejects synthetic failed steps", () => {
  assert.throws(
    () =>
      assertTaskReviewDispatchMeasurement(
        {
          outcome: "op_rejected",
          dispatches: [{ taskId: "task-review-0", outcome: "failed" }],
        },
        1,
        0,
      ),
    /successful write path/u,
  );
});

test("task review execution and consent probes cover every declared collection", async () => {
  const executionDimensions = ["findings", "evidenceChecked", "resolutions"],
    consentDimensions = ["reviews", "consents", "dispositions"];
  for (const dimension of executionDimensions) {
    const id = `task-review-execution:${dimension}`,
      measured = {
        small: await measureTaskReviewExecution(process.cwd(), 100, dimension),
        large: await measureTaskReviewExecution(process.cwd(), 2000, dimension),
      };
    assert.deepEqual(evaluateCollectionCosts({ [id]: measured }).errors, [], id);
  }
  for (const dimension of consentDimensions) {
    const id = `task-review-consent:${dimension}`,
      measured = {
        small: await measureTaskReviewConsent(process.cwd(), 100, dimension),
        large: await measureTaskReviewConsent(process.cwd(), 2000, dimension),
      };
    assert.deepEqual(evaluateCollectionCosts({ [id]: measured }).errors, [], id);
  }
});

test("task amend applies every supplied patch through the production mutation", async () => {
  const measured = {
    small: await measureTaskAmendPatches(process.cwd(), 100),
    large: await measureTaskAmendPatches(process.cwd(), 2000),
  };
  assert.deepEqual(evaluateCollectionCosts({ "task-amend:patches": measured }).errors, []);
});

// The task package observed in production had 34,000 outputs. File-count work must stay linear.
test("worktree document bases scale through the 34,000-file production case", async (t) => {
  const measurements = [];
  for (const size of [100, 2000, 34000]) measurements.push(await measureWorktreeDocuments(process.cwd(), size));
  for (const size of [100, 2000, 34000])
    t.diagnostic(JSON.stringify(await measureWorktreeDocuments(process.cwd(), size, true)));
  assert.deepEqual(
    evaluateCollectionCosts({
      "task-submit:worktree-documents": { small: measurements[0], large: measurements[1] },
    }).errors,
    [],
  );
  for (const measurement of measurements) t.diagnostic(JSON.stringify(measurement));
});
