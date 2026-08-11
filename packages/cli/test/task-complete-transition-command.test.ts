// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskLifecycleArgs,
  runTaskLifecycleFacade,
  type TaskLifecycleServiceInput
} from "../src/commands/core/task-lifecycle.ts";

const actor = {
  principal: { personId: "person_zeyu" },
  executor: { kind: "agent" as const, id: "owner-session" }
};

test("complete sends a field-equal CompleteTask intent to the host", async () => {
  const parsed = parseTaskLifecycleArgs([
    "task", "complete", "task_TYPED", "--execution-id", "exe_TYPED"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  let received: TaskLifecycleServiceInput | undefined;
  await runTaskLifecycleFacade(parsed.value, {
    actor,
    service: {
      execute: async (input) => {
        received = input;
        return { outcome: "applied", opId: input.command.opId, revision: 8 };
      },
      show: async () => ({ outcome: "applied", evidence: "unused" })
    }
  });
  assert.deepEqual(received, {
    command: {
      type: "CompleteTask",
      taskId: "task_TYPED",
      actor,
      opId: received?.command.opId,
      executionId: "exe_TYPED"
    }
  });
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
      return { outcome: "applied" as const, opId: input.command.opId, revision: 8 };
    },
    show: async () => ({ outcome: "applied" as const, evidence: "unused" })
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parsed = parseTaskLifecycleArgs(["task", "complete", "task_RETRY", "--execution-id", "exe_RETRY"]);
    assert.equal(parsed.ok, true);
    if (parsed.ok) await runTaskLifecycleFacade(parsed.value, { actor, service });
  }
  assert.match(opIds[0] ?? "", /^task-complete-[a-f0-9]{64}$/u);
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
    service: {
      execute: async (input) => ({
        outcome: "rejected",
        opId: input.command.opId,
        code: "invalid_transition",
        origin: "task-lifecycle-service",
        nextAction: "Run `ha task show task_NO_SUBMISSION`; then start and submit an Execution before requesting both reviews."
      }),
      show: async () => ({ outcome: "applied", evidence: "unused" })
    }
  });
  assert.equal(receipt.outcome, "rejected");
  assert.equal(receipt.code, "invalid_transition");
  assert.match(receipt.nextAction ?? "", /show.*start.*submit.*reviews/iu);
  assert.equal("status" in receipt, false);
});
