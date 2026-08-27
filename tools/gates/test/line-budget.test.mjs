// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { evaluateLineBudget, headroomFor, main, mechanicalUpperBoundFor, parseBudgets } from "../line-budget.mjs";
import { BUDGETED_MODULES } from "../module-policy.mjs";
import { loadReceipts, signReceipt, verifyReceipt } from "../receipt-verify.mjs";
import { makeRepo, writeRepoFile } from "./helpers.mjs";

function budgetBody(kernel) {
  return `${JSON.stringify(
    {
      version: 1,
      ceilings: Object.fromEntries(
        BUDGETED_MODULES.map((moduleName) => [moduleName, moduleName === "kernel" ? kernel : 0]),
      ),
    },
    null,
    2,
  )}\n`;
}

function fixtureRepo() {
  return makeRepo({
    "packages/kernel/src/index.ts": "one\ntwo\n",
    "tools/gates/line-budgets.json": budgetBody(2),
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

test("G32 does not measure budget-exempt tooling production", () => {
  const { rootDir, base } = fixtureRepo();
  writeRepoFile(rootDir, "tools/gates/new-rule.mjs", "one\ntwo\nthree\n");
  const result = evaluateLineBudget({ rootDir, base });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(Object.hasOwn(result.actual, "tooling"), false);
  assert.equal(result.actual.kernel, 2);
});

test("G32 reports an over-limit module as advisory without a failing exit code", () => {
  const { rootDir, base } = fixtureRepo();
  writeRepoFile(rootDir, "packages/kernel/src/index.ts", "one\ntwo\nthree\n");
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => stdout.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
  try {
    assert.equal(main(["--base", base], rootDir), 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.ok(stdout.includes("G32 line-budget-ratchet: advisory"));
  assert.match(stderr.join("\n"), /advisory: kernel: actual 3 exceeds ceiling 2/u);
});

test("G32 rejects a ceiling above the measured mechanical upper bound", () => {
  const { rootDir, base } = fixtureRepo();
  const ceiling = mechanicalUpperBoundFor("kernel") + 1;
  writeRepoFile(rootDir, "tools/gates/line-budgets.json", budgetBody(ceiling));
  const unsigned = {
    decisionId: "dec_01KZQ92VEPTDRS2HS8CKDBKW2Q",
    scope: "module:kernel",
    kind: "line-budget",
    limit: ceiling,
    expiry: "2099-12-31T23:59:59Z",
  };
  writeRepoFile(
    rootDir,
    "tools/gates/receipts/kernel.json",
    `${JSON.stringify({ ...unsigned, signature: signReceipt(unsigned) }, null, 2)}\n`,
  );

  const result = evaluateLineBudget({ rootDir, base, receiptsDir: path.join(rootDir, "tools/gates/receipts") });
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /kernel: ceiling 35826 exceeds mechanical upper bound 35825 derived from 28825 measured lines/u,
  );
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
  assert.deepEqual(
    { ok: reduced.ok, actual: reduced.actual.kernel, ceiling: reduced.ceilings.kernel },
    { ok: true, actual: 1, ceiling: 2 },
  );
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
    expiry: "2099-12-31T23:59:59Z",
  };
  writeRepoFile(
    rootDir,
    "tools/gates/receipts/kernel.json",
    `${JSON.stringify({ ...unsigned, signature: signReceipt(unsigned) }, null, 2)}\n`,
  );
  const result = evaluateLineBudget({ rootDir, base, receiptsDir: path.join(rootDir, "tools/gates/receipts") });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("current budgets reject retired buckets while historical budgets accept only named retirements", () => {
  const currentWithRetired = JSON.parse(budgetBody(2));
  currentWithRetired.ceilings["decision-fact"] = 563;
  assert.throws(() => parseBudgets(JSON.stringify(currentWithRetired)), /unknown: decision-fact/u);
  const historicalWithTestInfra = JSON.parse(budgetBody(2));
  historicalWithTestInfra.ceilings["test-infra"] = 0;
  assert.deepEqual(
    parseBudgets(JSON.stringify(historicalWithTestInfra), "historical", true),
    JSON.parse(budgetBody(2)).ceilings,
  );
  const historicalWithUnknown = JSON.parse(budgetBody(2));
  historicalWithUnknown.ceilings.surprise = 1;
  assert.throws(() => parseBudgets(JSON.stringify(historicalWithUnknown), "historical", true), /unknown: surprise/u);
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
    limit: 563,
  }),
});

test("every committed line-budget receipt verifies, active raised ceilings are covered, and retired receipts are explicit", () => {
  const gatesDir = path.join(import.meta.dirname, "..");
  const ceilings = parseBudgets(readFileSync(path.join(gatesDir, "line-budgets.json"), "utf8"));
  const receipts = loadReceipts(path.join(gatesDir, "receipts")).filter(
    ({ receipt }) => receipt?.kind === "line-budget",
  );
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
    if (BUDGETED_MODULES.includes(moduleName)) continue;
    const fileName = path.basename(filePath);
    assert.ok(
      RETIRED_LINE_BUDGET_RECEIPTS[fileName],
      `${filePath}: scope names an unknown module without an explicit retirement record`,
    );
    assert.deepEqual(
      { decisionId: receipt.decisionId, scope: receipt.scope, kind: receipt.kind, limit: receipt.limit },
      RETIRED_LINE_BUDGET_RECEIPTS[fileName],
      `${filePath}: retired receipt semantics changed`,
    );
    retiredReceiptFiles.push(fileName);
  }
  assert.deepEqual(retiredReceiptFiles.sort(), Object.keys(RETIRED_LINE_BUDGET_RECEIPTS).sort());
  // A receipt may outlive the ceiling it was minted for -- a ceiling can still be
  // lowered deliberately -- so the reverse direction is the one worth asserting: every ceiling
  // that a receipt was needed for still has one that reaches it. The module list
  // is derived from what is committed rather than named here, so a module whose
  // receipt is minted below its ceiling fails instead of going unchecked.
  const activeReceipts = receipts.filter(({ receipt }) =>
    BUDGETED_MODULES.includes(receipt.scope.replace(/^module:/u, "")),
  );
  const receiptModules = [...new Set(activeReceipts.map(({ receipt }) => receipt.scope.replace(/^module:/u, "")))];
  for (const moduleName of receiptModules) {
    assert.ok(
      activeReceipts.some(
        ({ receipt }) =>
          verifyReceipt(receipt, {
            scope: `module:${moduleName}`,
            kind: "line-budget",
            minimumLimit: ceilings[moduleName],
            now,
          }).ok,
      ),
      `${moduleName}: ceiling ${ceilings[moduleName]} has no receipt the gate would accept`,
    );
  }
  // Superseded receipts are deleted, not stacked: the gate reads whichever one
  // verifies, so a module carrying several is carrying expiries nobody is
  // tracking -- and this test fails the day the oldest of them lapses.
  assert.deepEqual(
    receiptModules.filter(
      (moduleName) => activeReceipts.filter(({ receipt }) => receipt.scope === `module:${moduleName}`).length > 1,
    ),
    [],
    "each module keeps exactly one line-budget receipt; supersede by replacing the file",
  );
});

// The production counts below are the post-restoration measurement table. The
// candidate ceiling is always the measured count plus the shared headroom tier.
const DECISION_INPUT_LINES = Object.freeze({
  kernel: 28825,
  "task-lifecycle": 1317,
  "write-contract": 571,
  "doc-sync": 4346,
  preset: 5489,
  cli: 5586,
  gui: 32684,
  daemon: 32090,
  fleet: 3203,
  "authority-write-path": 0,
  "identity-rbac": 616,
  "agent-runtime": 3719,
  decision: 768,
  fact: 1058,
});

test("the headroom tiers match the decision's table at every boundary", () => {
  assert.deepEqual(
    [1, 499, 500, 1999, 2000, 9999, 10000, 25000].map((measured) => headroomFor(measured)),
    [400, 400, 1000, 1000, 4000, 4000, 7000, 7000],
  );
});

// Binding the tier rule to what is actually committed is the only way it can
// fail: the rule lives in a decision, not in the gate, so nothing else notices a
// ceiling that was picked rather than derived.
test("every committed ceiling is the tier rule applied to the lines it was derived from", () => {
  const committed = parseBudgets(readFileSync(path.join(import.meta.dirname, "..", "line-budgets.json"), "utf8"));
  assert.deepEqual(
    Object.keys(DECISION_INPUT_LINES).sort(),
    [...BUDGETED_MODULES].sort(),
    "a module without a recorded line count would skip the tier rule unnoticed",
  );

  // Candidate ceilings are derived from the measured module lines and the shared
  // headroom function, so the check below exercises the same mechanical rule used
  // by the production measurement table.
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
    assert.equal(
      accepts(moduleName, tierCeiling),
      true,
      `${moduleName}: candidate ceiling must remain mechanically admissible`,
    );
    assert.equal(
      committed[moduleName],
      tierCeiling,
      `${moduleName}: ${measured} lines earns ${tierCeiling}, not ${committed[moduleName]}`,
    );
  }
});
