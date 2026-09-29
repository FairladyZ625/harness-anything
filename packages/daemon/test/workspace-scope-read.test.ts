// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import { workspaceScopeFromProjection } from "../src/workspace-scope-read.ts";

const task = (
  taskId: string,
  parentTaskId: string | null,
  status: "planned" | "active" | "blocked" | "done" | "cancelled",
  taskClass: "standard" | "work" = "standard",
  packageDisposition: "active" | "archived" = "active",
) => ({
  taskId,
  parentTaskId,
  status,
  taskClass,
  title: taskId,
  pinned: taskId === "root",
  workKind: null,
  riskTier: null,
  urgency: null,
  packageDisposition,
  packagePath: `harness/tasks/${taskId}`,
  updatedAt: "2026-09-20T00:00:00.000Z",
});

test("workspace scope counts only executable leaves and keeps cancellation separate", () => {
  const rows = [
    task("root", null, "active", "work"),
    task("group", "root", "active", "work"),
    task("doing", "group", "active"),
    task("done", "root", "done"),
    task("cancelled", "root", "cancelled", "standard", "archived"),
    task("outside", null, "done"),
  ];
  const result = workspaceScopeFromProjection(
    {
      readTaskIndex: () => ({ status: "ready", rows, watermark: 12, sourceRevision: 12, warnings: [] }),
    } as never,
    { rootTaskId: "root", limit: 2 },
  );

  assert.deepEqual(result.counts, { done: 1, executing: 1, pending: 0, blocked: 0, planned: 0, cancelled: 1 });
  assert.equal(result.scope.descendantCount, 4);
  assert.equal(result.scope.executableLeafCount, 3);
  assert.equal(result.scope.archivedCount, 1);
  assert.deepEqual(
    result.groups.map(({ taskId }) => taskId),
    ["group"],
  );
  assert.deepEqual(
    result.tasks.map(({ taskId }) => taskId),
    ["cancelled", "doing"],
  );
  assert.equal(result.page.nextCursor, "doing");
  assert.deepEqual(result.memberTaskIds, ["cancelled", "doing", "done", "group"]);
});

test("workspace scope reports a missing ancestor instead of inventing a breadcrumb", () => {
  const result = workspaceScopeFromProjection(
    {
      readTaskIndex: () => ({
        status: "pending",
        rows: [task("root", "missing", "planned", "work")],
        watermark: 8,
        sourceRevision: 9,
        warnings: ["projection_missing"],
      }),
    } as never,
    { rootTaskId: "root" },
  );
  assert.deepEqual(result.incompleteParentRefs, ["missing"]);
  assert.equal(result.status, "pending");
  assert.deepEqual(result.ancestors, []);
});

test("workspace scope cursor drains mixed-case task ids in sort order", () => {
  const rows = [
    task("root", null, "active", "work"),
    task("task_A", "root", "planned"),
    task("task_a", "root", "planned"),
  ];
  const projection = {
    readTaskIndex: () => ({ status: "ready", rows, watermark: 12, sourceRevision: 12, warnings: [] }),
  } as never;
  const taskIds: string[] = [];
  let cursor: string | undefined;

  do {
    const page = workspaceScopeFromProjection(projection, {
      rootTaskId: "root",
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    taskIds.push(...page.tasks.map(({ taskId }) => taskId));
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  assert.deepEqual(taskIds, ["task_a", "task_A"]);
});
