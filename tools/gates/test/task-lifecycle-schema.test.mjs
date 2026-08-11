// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  reduceTaskEvent,
  serializeTaskEvent,
  TASK_LIFECYCLE_SCHEMA,
  emptyTaskLifecycleSnapshot,
  validateTaskEvent
} from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { REPLAY_TASK_GRAPH } from "../../../packages/kernel/src/domain/task-graph.ts";
import { validateLeaseV1 } from "../../../packages/kernel/src/domain/execution.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "worker" } };

test("G09 closes the Task/v1 schema through a task-event/v1 parser", () => {
  const event = {
    schema: "task-event/v1",
    eventId: "evt-1",
    workspaceRevision: 1,
    opId: "op-1",
    taskId: "task-1",
    type: "task_created",
    actor,
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v1",
        taskId: "task-1",
        title: "Replay task",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: actor,
        completionGateIds: []
      }
    }
  };
  assert.equal(TASK_LIFECYCLE_SCHEMA.id, "task-lifecycle/v1");
  assert.deepEqual(validateTaskEvent(event), []);
  assert.equal(JSON.parse(serializeTaskEvent(event)).schema, "task-event/v1");
  assert.equal(reduceTaskEvent(emptyTaskLifecycleSnapshot(), event).task.taskId, "task-1");
  assert.match(validateTaskEvent({ ...event, schema: "task-event/v0" }).map((issue) => issue.code).join(","), /invalid_schema/u);
});

test("G09 exposes only Task, Execution, Lease, and Review v1 entity facets", () => {
  assert.deepEqual(
    [TASK_LIFECYCLE_SCHEMA.task.id, TASK_LIFECYCLE_SCHEMA.execution.id, TASK_LIFECYCLE_SCHEMA.lease.id, TASK_LIFECYCLE_SCHEMA.review.id],
    ["Task/v1", "Execution/v1", "Lease/v1", "Review/v1"]
  );
  const lease = {
    schema: "lease/v1",
    taskId: "task-1",
    executionId: "execution-0",
    actor,
    phase: "active",
    expiresAt: "2026-08-11T01:00:00.000Z",
    version: 1
  };
  assert.deepEqual(validateLeaseV1(lease), []);
  assert.match(validateLeaseV1({ ...lease, credentialHash: "removed" }).map((issue) => issue.code).join(","), /invalid_lease/u);
  assert.match(validateLeaseV1({ ...lease, schema: "lease/v0" }).map((issue) => issue.code).join(","), /invalid_schema/u);
});
