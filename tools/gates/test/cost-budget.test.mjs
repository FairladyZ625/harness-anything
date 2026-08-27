// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateCostBudget, measureCosts, readCostFixture } from "../cost-budget.mjs";
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

test("G37 measures the production rebuild counter and fixed first-screen reads", async () => {
  assert.deepEqual(await measureCosts(readCostFixture(path.join(setup(), "fixture.json"))), {
    projectionRebuildGitProcesses: 4,
    firstScreenReadRpcs: 7,
  });
});

test("G37 passes at the committed ceiling and rejects a first-screen read regression", async () => {
  const rootDir = setup();
  assert.equal((await evaluateCostBudget({ rootDir })).ok, true);
  const changed = fixture();
  changed.firstScreenReads.push("regressionRead");
  writeFileSync(path.join(rootDir, "fixture.json"), `${JSON.stringify(changed)}\n`);
  const result = await evaluateCostBudget({ rootDir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /firstScreenReadRpcs: measured 8 exceeds budget 7/u);
});

test("G37 requires a signed receipt for a budget increase", async () => {
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

test("G37 rejects lowering the baseline without lowering the active ceiling", async () => {
  const rootDir = setup();
  const budgetPath = path.join(rootDir, "tools/gates/cost-budget.json");
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  budget.baseline.firstScreenReadRpcs = 6;
  writeFileSync(budgetPath, `${JSON.stringify(budget)}\n`);
  const result = await evaluateCostBudget({ rootDir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /firstScreenReadRpcs: budget rose from 6 to 7/u);
});
