// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { validateTaskEvent } from "../../src/domain/task-lifecycle-event.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";

const actor = { principal: { personId: "person-owner" }, executor: null } as const;
const task = {
  schema: "task/v1" as const,
  taskId: "task_owner_mutation",
  title: "Owner mutation contract",
  taskClass: "standard" as const,
  status: "active" as const,
  graph: REPLAY_TASK_GRAPH,
  currentNode: "implementation" as const,
  iteration: 0 as const,
  createdBy: actor,
  completionGateIds: [],
  presetSnapshotDigest: null,
};

function event(fields: readonly string[]) {
  return {
    schema: "task-event/v1" as const,
    eventId: "event-owner-mutation",
    workspaceRevision: 2,
    opId: "op-owner-mutation",
    taskId: task.taskId,
    type: "task_amended" as const,
    actor,
    source: "local" as const,
    occurredAt: "2026-08-25T00:00:00.000Z",
    payload: {
      task,
      mutation: { command: "amend" as const, reason: "contract probe", fields },
      documentClaims: [],
    },
  };
}

test("task-event boundary rejects every owner or createdBy mutation field", () => {
  for (const field of ["owner", "owner.principal", "createdBy", "createdBy.principal"]) {
    const issues = validateTaskEvent(event([field]));
    assert.ok(
      issues.some((issue) => issue.message.includes("task mutation audit fields are invalid")),
      `${field} must be rejected`,
    );
  }
});

test("task-event boundary keeps ordinary amend fields writable", () => {
  assert.deepEqual(validateTaskEvent(event(["title", "pinned"])), []);
});
