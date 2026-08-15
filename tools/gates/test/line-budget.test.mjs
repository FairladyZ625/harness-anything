// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { evaluateLineBudget, parseBudgets } from "../line-budget.mjs";
import { MODULES } from "../module-policy.mjs";
import { loadReceipts, signReceipt, verifyReceipt } from "../receipt-verify.mjs";
import { makeRepo, writeRepoFile } from "./helpers.mjs";

function budgetBody(kernel) {
  return `${JSON.stringify({
    version: 1,
    ceilings: Object.fromEntries(MODULES.map((moduleName) => [moduleName, moduleName === "kernel" ? kernel : 0]))
  }, null, 2)}\n`;
}

function fixtureRepo() {
  return makeRepo({
    "packages/kernel/src/index.ts": "one\ntwo\n",
    "tools/gates/line-budgets.json": budgetBody(2)
  });
}

test("G32 passes when actual lines equal the module ceiling", () => {
  const { rootDir, base } = fixtureRepo();
  const result = evaluateLineBudget({ rootDir, base });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.actual.kernel, 2);
});

test("G32 rejects production lines above the ceiling", () => {
  const { rootDir, base } = fixtureRepo();
  writeRepoFile(rootDir, "packages/kernel/src/index.ts", "one\ntwo\nthree\n");
  const result = evaluateLineBudget({ rootDir, base });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /actual 3 exceeds ceiling 2/u);
});

test("G32 captures line reductions in the same change", () => {
  const { rootDir, base } = fixtureRepo();
  writeRepoFile(rootDir, "packages/kernel/src/index.ts", "one\n");
  const stale = evaluateLineBudget({ rootDir, base });
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join("\n"), /lower the ceiling to 1/u);
  writeRepoFile(rootDir, "tools/gates/line-budgets.json", budgetBody(1));
  const ratcheted = evaluateLineBudget({ rootDir, base });
  assert.deepEqual({ ok: ratcheted.ok, actual: ratcheted.actual.kernel, ceiling: ratcheted.ceilings.kernel }, { ok: true, actual: 1, ceiling: 1 });
});

test("G32 accepts a ceiling increase only with a scoped decision receipt", () => {
  const { rootDir, base } = fixtureRepo();
  writeRepoFile(rootDir, "tools/gates/line-budgets.json", budgetBody(3));
  assert.match(evaluateLineBudget({ rootDir, base }).errors.join("\n"), /without a valid receipt/u);

  const unsigned = {
    decisionId: "dec_01KZQ92VEPTDRS2HS8CKDBKW2Q",
    scope: "module:kernel",
    kind: "line-budget",
    limit: 3,
    expiry: "2099-12-31T23:59:59Z"
  };
  writeRepoFile(rootDir, "tools/gates/receipts/kernel.json", `${JSON.stringify({ ...unsigned, signature: signReceipt(unsigned) }, null, 2)}\n`);
  const result = evaluateLineBudget({ rootDir, base, receiptsDir: path.join(rootDir, "tools/gates/receipts") });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("G32 introduces the design-approved write-contract bucket at no more than 350 lines", () => {
  const legacyModules = MODULES.filter((name) => name !== "write-contract");
  const legacyBudget = `${JSON.stringify({ version: 1, ceilings: Object.fromEntries(legacyModules.map((name) => [name, name === "kernel" ? 2 : 0])) }, null, 2)}\n`;
  const { rootDir, base } = makeRepo({ "packages/kernel/src/index.ts": "one\ntwo\n", "tools/gates/line-budgets.json": legacyBudget });
  writeRepoFile(rootDir, "packages/kernel/src/domain/write-chain.contract.ts", "contract\n");
  writeRepoFile(rootDir, "tools/gates/line-budgets.json", budgetBody(2).replace('"write-contract": 0', '"write-contract": 350'));
  const result = evaluateLineBudget({ rootDir, base });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.actual["write-contract"], 1);
});

test("G32 introduces the Decision/Fact bucket with the 480-line design ceiling", () => {
  const legacyModules = MODULES.filter((name) => name !== "decision-fact");
  const legacyBudget = `${JSON.stringify({ version: 1, ceilings: Object.fromEntries(legacyModules.map((name) => [name, name === "kernel" ? 2 : 0])) }, null, 2)}\n`;
  const { rootDir, base } = makeRepo({ "packages/kernel/src/index.ts": "one\ntwo\n", "tools/gates/line-budgets.json": legacyBudget });
  writeRepoFile(rootDir, "packages/kernel/src/domain/fact-event.ts", "event\n");
  writeRepoFile(rootDir, "tools/gates/line-budgets.json", budgetBody(2).replace('"decision-fact": 0', '"decision-fact": 480'));
  const result = evaluateLineBudget({ rootDir, base });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.actual["decision-fact"], 1);
});

test("G32 introduces the Fleet bucket with the 350-line design ceiling", () => {
  const legacyModules = MODULES.filter((name) => name !== "fleet");
  const legacyBudget = `${JSON.stringify({ version: 1, ceilings: Object.fromEntries(legacyModules.map((name) => [name, name === "kernel" ? 2 : 0])) }, null, 2)}\n`;
  const { rootDir, base } = makeRepo({ "packages/kernel/src/index.ts": "one\ntwo\n", "tools/gates/line-budgets.json": legacyBudget });
  writeRepoFile(rootDir, "packages/daemon/src/fleet/contract.ts", "contract\n");
  writeRepoFile(rootDir, "tools/gates/line-budgets.json", budgetBody(2).replace('"fleet": 0', '"fleet": 350'));
  const result = evaluateLineBudget({ rootDir, base });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.actual.fleet, 1);
});

// The tests above prove the mechanism on synthetic repositories. This one reads
// what is actually committed: a raised ceiling only stands while its receipt
// verifies, so a receipt that stopped verifying would leave the ceiling unbacked
// without anything failing.
test("every committed line-budget receipt verifies, and the raised ceilings are covered", () => {
  const gatesDir = path.join(import.meta.dirname, "..");
  const ceilings = parseBudgets(readFileSync(path.join(gatesDir, "line-budgets.json"), "utf8"));
  const receipts = loadReceipts(path.join(gatesDir, "receipts")).filter(({ receipt }) => receipt?.kind === "line-budget");
  assert.ok(receipts.length > 0, "no line-budget receipts are committed");
  // verifyReceipt, not a hand-rolled schema+signature pair: expiry is the half a
  // hand-rolled check silently drops, and an expired receipt is exactly the case
  // this test claims to catch -- it still parses and still signs, but the gate
  // stops accepting it, so the ceiling it backs goes unbacked while this stays green.
  const now = new Date();
  for (const { filePath, receipt } of receipts) {
    assert.deepEqual(verifyReceipt(receipt, { now }).errors, [], filePath);
    assert.ok(MODULES.includes(receipt.scope.replace(/^module:/u, "")), `${filePath}: scope names an unknown module`);
  }
  // A receipt may outlive the ceiling it was minted for -- the ratchet only ever
  // falls -- so the reverse direction is the one worth asserting: every ceiling
  // that a receipt was needed for still has one that reaches it.
  for (const moduleName of ["cli", "daemon"]) {
    assert.ok(receipts.some(({ receipt }) => verifyReceipt(receipt, {
      scope: `module:${moduleName}`, kind: "line-budget", minimumLimit: ceilings[moduleName], now
    }).ok), `${moduleName}: ceiling ${ceilings[moduleName]} has no receipt the gate would accept`);
  }
});
