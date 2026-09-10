// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateCostBudget, evaluateG1WriteCostScaling, measureCosts, readCostFixture } from "../cost-budget.mjs";
import { signReceipt } from "../receipt-verify.mjs";

function fixture() {
  return JSON.parse(
    readFileSync(new URL("../../../packages/daemon/fixtures/perf/cost-budget-ledger.json", import.meta.url), "utf8"),
  );
}

function setup() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-cost-budget-"));
  mkdirSync(path.join(rootDir, "tools/gates/receipts"), { recursive: true });
  writeFileSync(path.join(rootDir, "fixture.json"), `${JSON.stringify(fixture())}\n`);
  writeFileSync(
    path.join(rootDir, "tools/gates/cost-budget.json"),
    `${JSON.stringify({
      schema: "cost-budget/v1",
      fixture: "fixture.json",
      baseline: { projectionRebuildGitProcesses: 4, firstScreenReadRpcs: 7 },
      budgets: { projectionRebuildGitProcesses: 4, firstScreenReadRpcs: 7 },
    })}\n`,
  );
  return rootDir;
}

test("G38 measures the production rebuild counter and fixed first-screen reads", async () => {
  assert.deepEqual(await measureCosts(readCostFixture(path.join(setup(), "fixture.json"))), {
    // Rebuild reads the accepting SQLite ledger; it no longer spawns Git.
    projectionRebuildGitProcesses: 0,
    firstScreenReadRpcs: 7,
  });
});

test("G38 passes at the committed ceiling and rejects a first-screen read regression", async () => {
  const rootDir = setup();
  assert.equal((await evaluateCostBudget({ rootDir })).ok, true);
  const changed = fixture();
  changed.firstScreenReads.push("regressionRead");
  writeFileSync(path.join(rootDir, "fixture.json"), `${JSON.stringify(changed)}\n`);
  const result = await evaluateCostBudget({ rootDir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /firstScreenReadRpcs: measured 8 exceeds budget 7/u);
});

test("G38 requires a signed receipt for a budget increase", async () => {
  const rootDir = setup();
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

test("G38 rejects lowering the baseline without lowering the active ceiling", async () => {
  const rootDir = setup();
  const budgetPath = path.join(rootDir, "tools/gates/cost-budget.json");
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  budget.baseline.firstScreenReadRpcs = 6;
  writeFileSync(budgetPath, `${JSON.stringify(budget)}\n`);
  const result = await evaluateCostBudget({ rootDir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /firstScreenReadRpcs: budget rose from 6 to 7/u);
});

// --- G1 write-path scale invariant ------------------------------------------------------------

const G1_OPS = Object.freeze(["op-a"]);
const G1_TEST_METRICS = Object.freeze(["sqlRowsRead", "gitProcesses"]);

function g1Setup({ baseline = { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } }, knownScaling = [] } = {}) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-g1-cost-budget-"));
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
      },
    })}\n`,
  );
  return rootDir;
}

function g1Measured(small, large, { operations = G1_OPS, metrics = G1_TEST_METRICS } = {}) {
  return { small: { counts: small }, large: { counts: large }, operations, metrics };
}

test("G1 passes when the 2000-scale count stays within the fixed margin of the 200-scale count", async () => {
  const rootDir = g1Setup();
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 100, gitProcesses: 4 } },
    { "op-a": { sqlRowsRead: 105, gitProcesses: 4 } },
  );
  const result = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("G1 rejects an unexempted operation whose count grows with ledger scale", async () => {
  const rootDir = g1Setup();
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

test("G1 tolerates a growing count when a live knownScaling exemption names the exact pair", async () => {
  const rootDir = g1Setup({
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

test("G1 fails a growing count guarded by an expired knownScaling exemption", async () => {
  const rootDir = g1Setup({
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

test("G1 fails a stale knownScaling exemption whose pair no longer grows", async () => {
  const rootDir = g1Setup({
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

test("G1 rejects a 200-scale measurement that exceeds the committed budget", async () => {
  const rootDir = g1Setup();
  const measured = g1Measured(
    { "op-a": { sqlRowsRead: 150, gitProcesses: 4 } },
    { "op-a": { sqlRowsRead: 155, gitProcesses: 4 } },
  );
  const result = await evaluateG1WriteCostScaling({ rootDir, measured });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /op-a\.sqlRowsRead: measured 150 at 200 events exceeds budget 100/u);
});

test("G1 requires a signed receipt to raise a committed budget above baseline", async () => {
  const rootDir = g1Setup();
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

test("G1 rejects a budget file missing an operation the measurement covers", async () => {
  const rootDir = g1Setup();
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
