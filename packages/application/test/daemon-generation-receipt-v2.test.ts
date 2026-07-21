// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { isCompoundOperationReceiptV2, type CompoundOperationReceiptV2 } from "../src/index.ts";
import { persistTerminalOrRejectGeneration } from "../src/authority/generation-fence-enforcement.ts";

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
    leaseGeneration: 1
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

test("generation fence rejection code and context are an explicit validated pair", () => {
  const authority = {
    tag: "RETRYABLE_NOT_COMMITTED" as const,
    workspaceId: "workspace-a",
    opId: "op-a",
    semanticDigest: "b".repeat(64),
    reason: "The daemon generation is stale.",
    errorCode: "DAEMON_GENERATION_FENCED" as const,
    errorContext: {
      schema: "daemon-generation-write-rejection/v1" as const,
      machineId: "machine-a",
      attemptedDaemonGeneration: 7,
      currentDaemonGeneration: 8,
      runtimeRegistrationId: "runtime-a",
      connectionId: "connection-a",
      workspaceId: "workspace-a",
      opId: "op-a",
      stage: "before-terminal-journal" as const
    }
  };
  assert.equal(isCompoundOperationReceiptV2(pending({ authority })), true);
  assert.equal(isCompoundOperationReceiptV2(pending({
    authority: { ...authority, errorContext: undefined }
  } as never)), false);
  assert.equal(isCompoundOperationReceiptV2(pending({
    authority: { ...authority, errorContext: { ...authority.errorContext, attemptedDaemonGeneration: 0 } }
  })), false);
});

test("a fenced indeterminate persistence attempt retains explicit rejection fields", async () => {
  const context = {
    schema: "daemon-generation-write-rejection/v1" as const,
    machineId: "machine-a",
    attemptedDaemonGeneration: 7,
    currentDaemonGeneration: 8,
    workspaceId: "workspace-a",
    opId: "op-a",
    stage: "before-terminal-journal" as const
  };
  const error = Object.assign(new Error("The daemon generation is stale."), {
    code: "DAEMON_GENERATION_FENCED" as const,
    context
  });
  const receipt = await persistTerminalOrRejectGeneration(
    async () => { throw error; },
    [{ workspaceId: "workspace-a", opId: "op-a" }, "b".repeat(64), "INDETERMINATE", {
      tag: "INDETERMINATE",
      workspaceId: "workspace-a",
      opId: "op-a",
      semanticDigest: "b".repeat(64),
      reason: "publication outcome unknown",
      commitSha: "c".repeat(40)
    }]
  );

  assert.equal(receipt.tag, "INDETERMINATE");
  assert.equal(receipt.tag === "INDETERMINATE" ? receipt.errorCode : undefined, "DAEMON_GENERATION_FENCED");
  assert.deepEqual(receipt.tag === "INDETERMINATE" ? receipt.errorContext : undefined, context);
  assert.equal(receipt.tag === "INDETERMINATE" ? receipt.commitSha : undefined, "c".repeat(40));
});
