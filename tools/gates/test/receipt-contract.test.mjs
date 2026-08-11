// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createReceipt, ReceiptContractError, validateReceipt } from "../receipt-contract.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("G04 accepts all four receipt outcomes and requires honest error fields", () => {
  assert.deepEqual(validateReceipt({ outcome: "applied", revision: 7, evidence: "event:7" }), []);
  assert.deepEqual(validateReceipt({ outcome: "pending", opId: "op_1" }), []);
  assert.deepEqual(validateReceipt({
    outcome: "indeterminate",
    opId: "op_2",
    code: "readback_unknown",
    origin: "daemon",
    nextAction: "query the operation by opId"
  }), []);
  assert.deepEqual(validateReceipt(fixture("receipt-error-golden.json")), []);
});

test("G04 permits the one-time start credential only as a complete applied payload", () => {
  assert.deepEqual(validateReceipt({
    outcome: "applied",
    opId: "task-start-op",
    revision: 2,
    nextAction: "Save it now; submit requires this credential.",
    leaseCredential: "one-time-secret",
    leaseExpiry: "2026-08-11T01:00:00.000Z"
  }), []);
  assert.match(validateReceipt({ outcome: "applied", leaseCredential: "orphan" }).join("\n"), /emitted together/u);
  assert.match(validateReceipt({
    outcome: "pending",
    leaseCredential: "secret",
    leaseExpiry: "2026-08-11T01:00:00.000Z"
  }).join("\n"), /only valid for an applied/u);
});

test("G06 error golden retains nextAction and incomplete errors fail", () => {
  assert.equal(fixture("receipt-error-golden.json").nextAction.length > 0, true);
  assert.match(validateReceipt(fixture("receipt-missing-next-action.json")).join("\n"), /nextAction is required/u);
});

test("G06 evidence-free results can only be N/A indeterminate", () => {
  const honest = {
    outcome: "indeterminate",
    opId: "op_3",
    code: "evidence_absent",
    origin: "N/A",
    nextAction: "collect readback evidence"
  };
  assert.deepEqual(validateReceipt(honest, { hasEvidence: false }), []);
  assert.match(validateReceipt({ outcome: "applied", revision: 1 }, { hasEvidence: false }).join("\n"), /must be indeterminate/u);
  assert.throws(() => createReceipt({ ...honest, origin: "daemon" }, { hasEvidence: false }), ReceiptContractError);
});
