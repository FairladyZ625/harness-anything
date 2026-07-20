// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { isCompoundOperationReceiptV2, type CompoundOperationReceiptV2 } from "../src/index.ts";

function pending(overrides: Partial<CompoundOperationReceiptV2> = {}): CompoundOperationReceiptV2 {
  return {
    schema: "compound-operation-receipt/v2",
    workspaceId: "workspace-a",
    viewId: "view-a",
    opId: "op-a",
    waiterId: "waiter-a",
    resultTokenDigest: "a".repeat(64),
    phase: "PENDING",
    delivery: "PENDING",
    pinReleaseEligible: false,
    currentLease: "NOT_REQUESTED",
    sequence: 0,
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides
  };
}

test("compound receipt v2 accepts omitted, partial, and full generation projections", () => {
  assert.equal(isCompoundOperationReceiptV2(pending()), true);
  assert.equal(isCompoundOperationReceiptV2(pending({ daemonGeneration: 2 })), true);
  assert.equal(isCompoundOperationReceiptV2(pending({
    machineId: "machine-installation-a",
    daemonGeneration: 2,
    runtimeRegistrationId: "runtime-a",
    connectionId: "connection-a",
    leaseGeneration: 1,
    errorCode: "DAEMON_GENERATION_FENCED"
  })), true);
  assert.equal(isCompoundOperationReceiptV2(pending({ daemonGeneration: 0 })), false);
});

test("legacy compound receipt JSON remains byte-identical through decode and encode", () => {
  const before = Buffer.from(`${JSON.stringify(pending())}\n`);
  const decoded = JSON.parse(before.toString("utf8"));
  assert.equal(isCompoundOperationReceiptV2(decoded), true);
  const after = Buffer.from(`${JSON.stringify(decoded)}\n`);
  assert.equal(after.equals(before), true, "legacy compound receipt bytes drifted");
});
