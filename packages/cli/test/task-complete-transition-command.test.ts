// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskLifecycleArgs,
  runTaskLifecycleFacade,
  type TaskLifecycleServiceInput
} from "../src/commands/core/task-lifecycle.ts";
import { validateGateReceiptSet } from "../src/commands/core/task-lifecycle-host.ts";

const actor = {
  principal: { personId: "person_zeyu" },
  executor: { kind: "agent" as const, id: "owner-session" }
};
const workspaceId = "/workspace";

test("complete sends a field-equal CompleteTask intent to the host", async () => {
  const parsed = parseTaskLifecycleArgs([
    "task", "complete", "task_TYPED", "--execution-id", "exe_TYPED"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  let received: TaskLifecycleServiceInput | undefined;
  await runTaskLifecycleFacade(parsed.value, {
    actor,
    workspaceId,
    service: {
      execute: async (input) => {
        received = input;
        return { outcome: "applied", opId: input.command.opId, revision: 8, evidence: "task-event:event-8" };
      },
      show: async () => ({ outcome: "applied", opId: "read:task", revision: 8, evidence: "unused" })
    }
  });
  assert.deepEqual(received, {
    command: {
      type: "CompleteTask",
      schema: "normalized-command/v1",
      workspaceId,
      taskId: "task_TYPED",
      actor,
      opId: received?.command.opId,
      commandDigest: received?.command.commandDigest,
      executionId: "exe_TYPED"
    },
    gateReceipts: []
  });
});

test("complete preserves opaque gate receipt references and rejects malformed pairs", async () => {
  const parsed = parseTaskLifecycleArgs([
    "task", "complete", "task_GATED", "--execution-id", "exe_GATED",
    "--gate-receipt", "G10:artifacts/g10.json",
    "--gate-receipt", "G32:token:opaque"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  let received: TaskLifecycleServiceInput | undefined;
  await runTaskLifecycleFacade(parsed.value, {
    actor,
    workspaceId,
    service: {
      execute: async (input) => {
        received = input;
        return { outcome: "applied", opId: input.command.opId, revision: 8, evidence: "task-event:event-8" };
      },
      show: async () => ({ outcome: "applied", opId: "read:task", revision: 8, evidence: "unused" })
    }
  });
  assert.deepEqual(received?.gateReceipts, [
    { gateId: "G10", receiptRef: "artifacts/g10.json" },
    { gateId: "G32", receiptRef: "token:opaque" }
  ]);
  const malformed = parseTaskLifecycleArgs([
    "task", "complete", "task_GATED", "--execution-id", "exe_GATED", "--gate-receipt", "G10:"
  ]);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.error.nextAction, /gate-id.*receipt-ref/iu);
});

test("complete host names missing, unknown, and duplicate gate receipt differences", () => {
  assert.deepEqual(validateGateReceiptSet([], []), []);
  assert.deepEqual(validateGateReceiptSet(["G10"], [{ gateId: "G10", receiptRef: "opaque" }]), [
    { gateId: "G10", receiptRef: "opaque" }
  ]);
  assert.throws(
    () => validateGateReceiptSet(["G10", "G32"], [
      { gateId: "G10", receiptRef: "one" },
      { gateId: "G10", receiptRef: "two" },
      { gateId: "G99", receiptRef: "extra" }
    ]),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /missing=\[G32\].*unknown=\[G99\].*duplicate=\[G10\]/u);
      return true;
    }
  );
});

test("complete strict parser rejects unknown and missing fields", () => {
  const unknown = parseTaskLifecycleArgs([
    "task", "complete", "task_TYPED", "--execution-id", "exe_TYPED", "--status", "done"
  ]);
  const missing = parseTaskLifecycleArgs(["task", "complete", "task_TYPED"]);
  assert.equal(unknown.ok, false);
  assert.equal(missing.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "unknown_field");
  if (!missing.ok) {
    assert.equal(missing.error.code, "missing_field");
    assert.match(missing.error.nextAction, /--execution-id/u);
  }
});

test("same complete intent produces the same load-bearing opId", async () => {
  const opIds: string[] = [];
  const service = {
    execute: async (input: TaskLifecycleServiceInput) => {
      opIds.push(input.command.opId);
      return { outcome: "applied" as const, opId: input.command.opId, revision: 8, evidence: "task-event:event-8" };
    },
    show: async () => ({ outcome: "applied" as const, opId: "read:task", revision: 8, evidence: "unused" })
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parsed = parseTaskLifecycleArgs(["task", "complete", "task_RETRY", "--execution-id", "exe_RETRY"]);
    assert.equal(parsed.ok, true);
    if (parsed.ok) await runTaskLifecycleFacade(parsed.value, { actor, workspaceId, service });
  }
  assert.match(opIds[0] ?? "", /^op_[a-f0-9]{64}$/u);
  assert.equal(opIds[1], opIds[0]);
});

test("complete without a current submitted Execution stays rejected and teaches recovery", async () => {
  const parsed = parseTaskLifecycleArgs([
    "task", "complete", "task_NO_SUBMISSION", "--execution-id", "exe_MISSING"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const receipt = await runTaskLifecycleFacade(parsed.value, {
    actor,
    workspaceId,
    service: {
      execute: async (input) => ({
        outcome: "rejected",
        opId: input.command.opId,
        code: "invalid_transition",
        origin: "task-lifecycle-service",
        nextAction: "Run `ha task show task_NO_SUBMISSION`; then start and submit an Execution before requesting both reviews."
      }),
      show: async () => ({ outcome: "applied", opId: "read:task", revision: 8, evidence: "unused" })
    }
  });
  assert.equal(receipt.outcome, "rejected");
  assert.equal(receipt.code, "invalid_transition");
  assert.match(receipt.nextAction ?? "", /show.*start.*submit.*reviews/iu);
  assert.equal("status" in receipt, false);
});
