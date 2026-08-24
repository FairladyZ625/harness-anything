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

// Deleting production code must not tighten the budget. The old rule forced the
// ceiling down to the new actual on any reduction, which is why every module sat
// at exactly 100% before dec_407E904F6938FA9FD304D3E34E: each refactor pinned the
// ceiling back to whatever the code happened to measure. Headroom that a
// refactor can evaporate is not headroom, so the assertion runs the other way now.
test("G32 leaves the ceiling alone when production lines fall", () => {
  const { rootDir, base } = fixtureRepo();
  writeRepoFile(rootDir, "packages/kernel/src/index.ts", "one\n");
  const reduced = evaluateLineBudget({ rootDir, base });
  assert.deepEqual({ ok: reduced.ok, actual: reduced.actual.kernel, ceiling: reduced.ceilings.kernel }, { ok: true, actual: 1, ceiling: 2 });
  // Lowering it deliberately stays available -- it is just no longer compulsory.
  writeRepoFile(rootDir, "tools/gates/line-budgets.json", budgetBody(1));
  assert.equal(evaluateLineBudget({ rootDir, base }).ok, true);
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

test("G32 replaces the retired Decision/Fact bucket with exact Decision and Fact design ceilings", () => {
  const legacyModules = MODULES.filter((name) => name !== "decision" && name !== "fact");
  const legacyCeilings = Object.fromEntries(legacyModules.map((name) => [name, name === "kernel" ? 2 : 0]));
  legacyCeilings["decision-fact"] = 563;
  const legacyBudget = `${JSON.stringify({ version: 1, ceilings: legacyCeilings }, null, 2)}\n`;
  const { rootDir, base } = makeRepo({
    "packages/kernel/src/index.ts": "one\ntwo\n",
    "packages/kernel/src/domain/fact-event.ts": "legacy decision\nlegacy fact\n",
    "tools/gates/line-budgets.json": legacyBudget
  });
  writeRepoFile(rootDir, "packages/kernel/src/domain/decision-event.ts", "decision\n");
  writeRepoFile(rootDir, "packages/kernel/src/domain/fact-event.ts", "fact\n");
  writeRepoFile(rootDir, "tools/gates/line-budgets.json", budgetBody(2)
    .replace('"decision": 0', '"decision": 286')
    .replace('"fact": 0', '"fact": 307'));
  const result = evaluateLineBudget({ rootDir, base });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(
    { decision: result.actual.decision, fact: result.actual.fact, baseFact: result.baseActual.fact },
    { decision: 1, fact: 1, baseFact: 2 }
  );
});

test("current budgets reject the retired Decision/Fact bucket and historical budgets reject arbitrary unknown buckets", () => {
  const currentWithRetired = JSON.parse(budgetBody(2));
  currentWithRetired.ceilings["decision-fact"] = 563;
  assert.throws(() => parseBudgets(JSON.stringify(currentWithRetired)), /unknown: decision-fact/u);
  const historicalWithUnknown = JSON.parse(budgetBody(2));
  historicalWithUnknown.ceilings.surprise = 1;
  assert.throws(() => parseBudgets(JSON.stringify(historicalWithUnknown), "historical", true), /unknown: surprise/u);
});

// The caps were doubled under dec_D848EF980B86800CFC6BD82125; they are no longer
// the exact split measurements, but they are still hard refusals.
test("Decision and Fact ceilings above their doubled design caps are rejected", () => {
  for (const [moduleName, limit] of [["decision", 572], ["fact", 614]]) {
    assert.throws(
      () => parseBudgets(budgetBody(2).replace(`"${moduleName}": 0`, `"${moduleName}": ${limit + 1}`)),
      new RegExp(`${moduleName} exceeds its design limit ${limit}`, "u")
    );
  }
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
const RETIRED_LINE_BUDGET_RECEIPTS = Object.freeze({
  "line-budget-decision-fact-563.json": Object.freeze({
    decisionId: "dec_58420E6F1D934B9841F06A95E9",
    scope: "module:decision-fact",
    kind: "line-budget",
    limit: 563
  })
});

test("every committed line-budget receipt verifies, active raised ceilings are covered, and retired receipts are explicit", () => {
  const gatesDir = path.join(import.meta.dirname, "..");
  const ceilings = parseBudgets(readFileSync(path.join(gatesDir, "line-budgets.json"), "utf8"));
  const receipts = loadReceipts(path.join(gatesDir, "receipts")).filter(({ receipt }) => receipt?.kind === "line-budget");
  assert.ok(receipts.length > 0, "no line-budget receipts are committed");
  // verifyReceipt, not a hand-rolled schema+signature pair: expiry is the half a
  // hand-rolled check silently drops, and an expired receipt is exactly the case
  // this test claims to catch -- it still parses and still signs, but the gate
  // stops accepting it, so the ceiling it backs goes unbacked while this stays green.
  const now = new Date();
  const retiredReceiptFiles = [];
  for (const { filePath, receipt } of receipts) {
    assert.deepEqual(verifyReceipt(receipt, { now }).errors, [], filePath);
    const moduleName = receipt.scope.replace(/^module:/u, "");
    if (MODULES.includes(moduleName)) continue;
    const fileName = path.basename(filePath);
    assert.ok(RETIRED_LINE_BUDGET_RECEIPTS[fileName], `${filePath}: scope names an unknown module without an explicit retirement record`);
    assert.deepEqual(
      { decisionId: receipt.decisionId, scope: receipt.scope, kind: receipt.kind, limit: receipt.limit },
      RETIRED_LINE_BUDGET_RECEIPTS[fileName],
      `${filePath}: retired receipt semantics changed`
    );
    retiredReceiptFiles.push(fileName);
  }
  assert.deepEqual(retiredReceiptFiles.sort(), Object.keys(RETIRED_LINE_BUDGET_RECEIPTS).sort());
  // A receipt may outlive the ceiling it was minted for -- a ceiling can still be
  // lowered deliberately -- so the reverse direction is the one worth asserting: every ceiling
  // that a receipt was needed for still has one that reaches it. The module list
  // is derived from what is committed rather than named here, so a module whose
  // receipt is minted below its ceiling fails instead of going unchecked.
  const activeReceipts = receipts.filter(({ receipt }) => MODULES.includes(receipt.scope.replace(/^module:/u, "")));
  const receiptModules = [...new Set(activeReceipts.map(({ receipt }) => receipt.scope.replace(/^module:/u, "")))];
  for (const moduleName of receiptModules) {
    assert.ok(activeReceipts.some(({ receipt }) => verifyReceipt(receipt, {
      scope: `module:${moduleName}`, kind: "line-budget", minimumLimit: ceilings[moduleName], now
    }).ok), `${moduleName}: ceiling ${ceilings[moduleName]} has no receipt the gate would accept`);
  }
  // Superseded receipts are deleted, not stacked: the gate reads whichever one
  // verifies, so a module carrying several is carrying expiries nobody is
  // tracking -- and this test fails the day the oldest of them lapses.
  assert.deepEqual(
    receiptModules.filter((moduleName) => activeReceipts.filter(({ receipt }) => receipt.scope === `module:${moduleName}`).length > 1),
    [],
    "each module keeps exactly one line-budget receipt; supersede by replacing the file"
  );
});

// dec_9C87C67DCE4073DB9AA56A8148 sets headroom as an absolute allowance banded by
// how large the module already is, so a ceiling nobody can reach in foreseeable
// time -- a gate that cannot ring -- stops being expressible.
// Headroom doubled under dec_D848EF980B86800CFC6BD82125: the capped modules had
// reached exactly zero headroom, which left joining lines as the only way to add
// code at all. Ceilings stay derived; only the tier table moved.
function headroomFor(measured) {
  if (measured < 500) return 400;
  if (measured < 2000) return 1000;
  if (measured < 10000) return 4000;
  return 7000;
}

// daemon was re-measured at 5a7fc71d: it had grown past the 2000-line tier
// boundary, so the 500-line headroom it earned at 1660 no longer applied to it
// (dec_FA1A0041BFD0FFC3D981A2ADC4). Every other module still carries the figure
// below.
// doc-sync and cli were re-measured at 4a7c77a2 after W3-C landed the dual-class
// sync surface there (dec_D989FB5E67364051D3F564AC82): doc-sync 350 -> 572 and
// cli 171 -> 377, both past what their old derivations covered.
// The production lines each ceiling was derived from, measured at c00066ba and
// taken as max(c00066ba, c00066ba merged with #1458) so the result is the same
// whichever of the two lands first. Only two modules differ between those trees:
// daemon (1630 -> 1660, #1458 adds lines) and gui (18494 -> 18414, #1458 removes
// them), so daemon uses the merged figure and gui the base one.
const DECISION_INPUT_LINES = Object.freeze({
  kernel: 21614, // re-measured after W2-B restoration under dec_402DC87500A06C7B4A81F00CCB
  "task-lifecycle": 375,
  "write-contract": 292,
  "doc-sync": 3849, // re-measured on the W2-B convergence tree (kernel + daemon restorations both raise this module)
  preset: 2623, // re-measured after W2-B restoration under dec_402DC87500A06C7B4A81F00CCB
  cli: 4615, // re-measured after W2-B restoration under dec_402DC87500A06C7B4A81F00CCB
  gui: 18494,
  daemon: 22892,
  fleet: 1482,
  "authority-write-path": 0,
  "identity-rbac": 563,
  "agent-runtime": 2157,
  decision: 286,
  fact: 307,
  "test-infra": 0
});

test("the headroom tiers match the decision's table at every boundary", () => {
  assert.deepEqual(
    [1, 499, 500, 1999, 2000, 9999, 10000, 25000].map((measured) => headroomFor(measured)),
    [400, 400, 1000, 1000, 4000, 4000, 7000, 7000]
  );
});

// Binding the tier rule to what is actually committed is the only way it can
// fail: the rule lives in a decision, not in the gate, so nothing else notices a
// ceiling that was picked rather than derived.
test("every committed ceiling is the tier rule applied to the lines it was derived from", () => {
  const committed = parseBudgets(readFileSync(path.join(import.meta.dirname, "..", "line-budgets.json"), "utf8"));
  assert.deepEqual(
    Object.keys(DECISION_INPUT_LINES).sort(),
    [...MODULES].sort(),
    "a module without a recorded line count would skip the tier rule unnoticed"
  );

  // The design caps in INITIAL_MODULE_CEILINGS are a separate decision and are not
  // exported, so they are probed rather than copied: a capped module is one whose
  // tier ceiling parseBudgets refuses, and it must then sit exactly at the cap.
  const accepts = (moduleName, value) => {
    try {
      parseBudgets(JSON.stringify({ version: 1, ceilings: { ...committed, [moduleName]: value } }));
      return true;
    } catch {
      return false;
    }
  };

  for (const [moduleName, measured] of Object.entries(DECISION_INPUT_LINES)) {
    // A module measuring zero lines carries a prohibition, not a budget: handing it
    // headroom would let new production code land there with no signal at all.
    if (measured === 0) {
      assert.equal(committed[moduleName], 0, `${moduleName}: a zero-line module must stay at zero`);
      continue;
    }
    const tierCeiling = measured + headroomFor(measured);
    if (accepts(moduleName, tierCeiling)) {
      assert.equal(committed[moduleName], tierCeiling, `${moduleName}: ${measured} lines earns ${tierCeiling}, not ${committed[moduleName]}`);
    } else {
      assert.equal(accepts(moduleName, committed[moduleName]), true, `${moduleName}: ceiling exceeds its design cap`);
      assert.equal(accepts(moduleName, committed[moduleName] + 1), false, `${moduleName}: tier ceiling ${tierCeiling} is capped, so the ceiling must sit exactly at the cap`);
    }
  }
});
