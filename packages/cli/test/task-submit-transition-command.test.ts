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

function submitArgs(): string[] {
  return [
    "task", "submit", "task_RETRY",
    "--execution-id", "exe_RETRY",
    "--claim", "ready",
    "--commit-sha", "b".repeat(40)
  ];
}

test("submit strict parser rejects unknown and missing command fields", () => {
  const unknown = parseTaskLifecycleArgs([...submitArgs(), "--extra", "ignored"]);
  const missing = parseTaskLifecycleArgs(submitArgs().slice(0, -2));
  assert.equal(unknown.ok, false);
  assert.equal(missing.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "unknown_field");
  if (!missing.ok) assert.equal(missing.error.code, "missing_field");
});

test("repeated submit intent preserves the same normalized opId", async () => {
  const received: TaskLifecycleServiceInput[] = [];
  const service = {
    execute: async (input: TaskLifecycleServiceInput) => {
      received.push(input);
      return { outcome: "applied" as const, opId: input.command.opId, revision: 9, evidence: "task-event:event-9" };
    },
    show: async () => ({ outcome: "applied" as const, opId: "read:task", revision: 9, evidence: "unused" })
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parsed = parseTaskLifecycleArgs(submitArgs());
    assert.equal(parsed.ok, true);
    if (parsed.ok) await runTaskLifecycleFacade(parsed.value, { actor, workspaceId: "/workspace", service });
  }

  assert.equal(received[1]?.command.opId, received[0]?.command.opId);
});
