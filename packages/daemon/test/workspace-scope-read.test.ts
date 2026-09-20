// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import { workspaceScopeFromProjection } from "../src/workspace-scope-read.ts";

const task = (
  taskId: string,
  parentTaskId: string | null,
  status: "planned" | "active" | "blocked" | "done" | "cancelled",
  taskClass: "standard" | "milestone" = "standard",
  packageDisposition: "active" | "archived" = "active",
) => ({
  taskId,
  parentTaskId,
  status,
  taskClass,
  title: taskId,
  pinned: taskId === "root",
  moduleKey: null,
  workKind: null,
  riskTier: null,
  urgency: null,
  packageDisposition,
  packagePath: `harness/tasks/${taskId}`,
  updatedAt: "2026-09-20T00:00:00.000Z",
});

test("workspace scope counts only executable leaves and keeps cancellation separate", () => {
  const rows = [
    task("root", null, "active", "milestone"),
    task("group", "root", "active", "milestone"),
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
});

test("workspace scope reports a missing ancestor instead of inventing a breadcrumb", () => {
  const result = workspaceScopeFromProjection(
    {
      readTaskIndex: () => ({
        status: "pending",
        rows: [task("root", "missing", "planned", "milestone")],
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
