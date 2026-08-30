// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalEventStore, TaskProjection } from "../../kernel/src/index.ts";
import { projectionWaitBudget, waitForTaskProjection } from "../src/projection-readiness-wait.ts";

test("task projection wait advances through a lagging canonical task cut", async () => {
  let reads = 0;
  const projection = {
      read: () => {
        reads += 1;
        return reads === 1 ? pendingTaskRead() : readyTaskRead();
      },
    } as unknown as TaskProjection,
    result = await waitForTaskProjection({
      budget: projectionWaitBudget(1_000),
      projection,
      store: taskStore("task_wait", 2),
      taskId: "task_wait",
      purpose: "integration test",
    });
  assert.equal(reads, 2);
  assert.equal(result.watermark, 2);
  assert.equal(result.sourceRevision, 2);
});

test("task projection wait times out with cut and elapsed diagnostics", async () => {
  await assert.rejects(
    waitForTaskProjection({
      budget: projectionWaitBudget(0),
      projection: { read: pendingTaskRead } as unknown as TaskProjection,
      store: taskStore("task_wait", 2),
      taskId: "task_wait",
      purpose: "integration test",
    }),
    (error: unknown) => {
      const record = error as Record<string, unknown>;
      assert.equal(record.code, "content_not_ready");
      assert.equal(record.watermark, 1);
      assert.equal(record.sourceRevision, 2);
      assert.equal(typeof record.waitedMs, "number");
      assert.match(String(record.message), /watermark 1, source revision 2, waited [0-9]+ ms/u);
      return true;
    },
  );
});

test("task projection wait rejects a missing canonical task without polling", async () => {
  let reads = 0;
  await assert.rejects(
    waitForTaskProjection({
      budget: projectionWaitBudget(1_000),
      projection: {
        read: () => {
          reads += 1;
          return pendingTaskRead();
        },
      } as unknown as TaskProjection,
      store: emptyStore(),
      taskId: "task_missing",
      purpose: "integration test",
    }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "task_not_found",
  );
  assert.equal(reads, 1);
});

function pendingTaskRead(): ReturnType<TaskProjection["read"]> {
  return {
    status: "pending",
    snapshot: { revision: 0, task: null, lease: null, executions: [] },
    packagePath: null,
    watermark: 1,
    sourceRevision: 2,
    warnings: [],
    catchUp: { maxItems: 1, reducedItems: 1, sqliteTransactions: 1 },
  } as ReturnType<TaskProjection["read"]>;
}

function readyTaskRead(): ReturnType<TaskProjection["read"]> {
  return {
    ...pendingTaskRead(),
    status: "ready",
    snapshot: { revision: 2, task: {}, lease: null, executions: [] },
    packagePath: "tasks/task_wait",
    watermark: 2,
  } as unknown as ReturnType<TaskProjection["read"]>;
}

function taskStore(taskId: string, workspaceRevision: number): CanonicalEventStore {
  return {
    read: () => ({
      schema: "canonical-event-stream/v1",
      revision: workspaceRevision,
      events: [{ schema: "task-event/v1", taskId, workspaceRevision }],
    }),
  } as unknown as CanonicalEventStore;
}

function emptyStore(): CanonicalEventStore {
  return {
    read: () => ({ schema: "canonical-event-stream/v1", revision: 0, events: [] }),
  } as unknown as CanonicalEventStore;
}
