// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWriteReceipt, validateWriteReceipt, WriteChainContractError } from "../../../packages/kernel/src/domain/write-chain.contract.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("G04 accepts all four receipt outcomes and requires honest error fields", () => {
  assert.deepEqual(validateWriteReceipt({ outcome: "applied", opId: "op_0", revision: 7, evidence: "event:7",
    visibility: "center", proof: { committedRevision: 7, appliedCut: 7, durable: true, canonicalVisible: true, worktreeVisible: null } }), []);
  assert.deepEqual(validateWriteReceipt({ outcome: "pending", opId: "op_1", revision: 7, evidence: "event:7", nextAction: "wait for the view",
    visibility: { kind: "replica", viewId: "node-1/task-view" }, proof: { committedRevision: 7, appliedCut: 6, durable: true, canonicalVisible: false, worktreeVisible: false } }), []);
  assert.deepEqual(validateWriteReceipt({
    outcome: "indeterminate",
    opId: "op_2",
    code: "readback_unknown",
    origin: "N/A",
    nextAction: "query the operation by opId"
  }), []);
  assert.deepEqual(validateWriteReceipt(fixture("receipt-error-golden.json")), []);
});

test("G04 rejects replica applied without an ACK committed at the applied cut", () => {
  const receipt = { outcome: "applied", opId: "op_replica", revision: 7, evidence: "event:7",
    visibility: { kind: "replica", viewId: "node-1/task-view" }, proof: { committedRevision: 7, appliedCut: 7, durable: true, canonicalVisible: true, worktreeVisible: true } };
  assert.match(validateWriteReceipt(receipt).join("\n"), /ackCut/u);
  assert.match(validateWriteReceipt({ ...receipt, proof: { ...receipt.proof, ackCut: 6 } }).join("\n"), /same cut/u);
  assert.deepEqual(validateWriteReceipt({ ...receipt, proof: { ...receipt.proof, ackCut: 7 } }), []);
});

test("G04 derives durable, canonical-visible, and worktree-visible independently", () => {
  const base = { outcome: "applied", opId: "op_visibility", revision: 3, evidence: "event:3", visibility: "center",
    proof: { committedRevision: 3, appliedCut: 3, durable: true, canonicalVisible: true, worktreeVisible: false } };
  assert.deepEqual(validateWriteReceipt(base), []);
  assert.match(validateWriteReceipt({ ...base, proof: { ...base.proof, durable: false } }).join("\n"), /durable/u);
  assert.match(validateWriteReceipt({ ...base, proof: { ...base.proof, canonicalVisible: false } }).join("\n"), /canonical-visible/u);
});

test("G04 rejects the removed one-time lease credential fields", () => {
  assert.match(validateWriteReceipt({
    outcome: "applied", opId: "task-start-op", revision: 2, evidence: "event:2",
    leaseCredential: "one-time-secret", leaseExpiry: "2026-08-11T01:00:00.000Z"
  }).join("\n"), /unexpected field: leaseCredential/u);
});

test("G06 error golden retains nextAction and incomplete errors fail", () => {
  assert.equal(fixture("receipt-error-golden.json").nextAction.length > 0, true);
  assert.match(validateWriteReceipt(fixture("receipt-missing-next-action.json")).join("\n"), /nextAction is required/u);
});

test("G06 evidence-free results can only be N/A indeterminate", () => {
  const honest = {
    outcome: "indeterminate",
    opId: "op_3",
    code: "evidence_absent",
    origin: "N/A",
    nextAction: "collect readback evidence"
  };
  assert.deepEqual(validateWriteReceipt(honest), []);
  assert.match(validateWriteReceipt({ ...honest, origin: "daemon" }).join("\n"), /evidence-free.*N\/A indeterminate/u);
  assert.match(validateWriteReceipt({ outcome: "applied", opId: "op_4", revision: 1 }).join("\n"), /requires revision and evidence/u);
  assert.throws(() => createWriteReceipt({ ...honest, origin: "" }), WriteChainContractError);
});
