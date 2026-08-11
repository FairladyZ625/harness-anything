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
  executor: { kind: "agent" as const, id: "executor-session" }
};

function submitArgs(leaseCredential: string): string[] {
  return [
    "task", "submit", "task_RETRY",
    "--execution-id", "exe_RETRY",
    "--lease-credential", leaseCredential,
    "--claim", "ready",
    "--commit-sha", "b".repeat(40)
  ];
}

test("submit strict parser rejects unknown and missing command fields", () => {
  const unknown = parseTaskLifecycleArgs([...submitArgs("lease-1"), "--extra", "ignored"]);
  const missing = parseTaskLifecycleArgs(submitArgs("lease-1").slice(0, -2));
  assert.equal(unknown.ok, false);
  assert.equal(missing.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "unknown_field");
  if (!missing.ok) assert.equal(missing.error.code, "missing_field");
});

test("refreshed lease credential preserves the same submit intent opId", async () => {
  const received: TaskLifecycleServiceInput[] = [];
  const service = {
    execute: async (input: TaskLifecycleServiceInput) => {
      received.push(input);
      return { outcome: "applied" as const, opId: input.command.opId, revision: 9 };
    },
    show: async () => ({ outcome: "applied" as const, evidence: "unused" })
  };
  for (const token of ["lease-1", "lease-2"]) {
    const parsed = parseTaskLifecycleArgs(submitArgs(token));
    assert.equal(parsed.ok, true);
    if (parsed.ok) await runTaskLifecycleFacade(parsed.value, { actor, service });
  }

  assert.equal(received[0]?.credential, "lease-1");
  assert.equal(received[1]?.credential, "lease-2");
  assert.equal(received[1]?.command.opId, received[0]?.command.opId);
});
