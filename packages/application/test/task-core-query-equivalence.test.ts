// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskV2 } from "@harness-anything/kernel";
import { taskListPayload } from "@harness-anything/application/internal/queries/task-list-read.ts";
import { taskWorkspaceView } from "@harness-anything/application/internal/queries/task-workspace-read.ts";
import { taskShowFromProjection } from "@harness-anything/application/internal/queries/task-show-read.ts";
import type { TaskProjectionQueries } from "@harness-anything/kernel";

const task = {
  taskId: "task_abc",
  taskClass: "standard",
  status: "active",
  packageDisposition: "active",
  presetSnapshotDigest: "digest",
} as TaskV2;

test("omitted worktree probe matches a probe that reports no checkout", () => {
  const root = "D:/harness-stateless-query";
  const readPresetSnapshot = () => ({ profile: { outputShape: "repository-diff" } });
  const omitted = taskWorkspaceView(root, task, "tasks/task_abc", readPresetSnapshot, root);
  const absent = taskWorkspaceView(root, task, "tasks/task_abc", readPresetSnapshot, root, () => false);
  assert.deepEqual(omitted, absent);
  assert.equal(omitted?.kind, "worktree");
  if (omitted?.kind === "worktree") assert.equal(omitted.state, "bound");
});

test("task list payload keeps the v2 page contract", () => {
  const row = {
    taskId: "task_abc",
    status: "active",
    title: "Core read",
    pinned: false,
    updatedAt: "2026-11-24T00:00:00.000Z",
    packagePath: "tasks/task_abc",
    packageDisposition: "active",
    taskClass: "standard",
  };
  const reads = {
    readTaskIndex: () => ({
      rows: [row],
      warnings: [],
      status: "ready" as const,
      watermark: 3,
      sourceRevision: 3,
      page: { nextCursor: "cursor-1" },
    }),
    readTaskChildCounts: () => ({ task_abc: 0 }),
    rootThreshold: 4,
  };
  const query = { limit: 10 };
  const first = taskListPayload(reads, query, {}, (code, message) => Object.assign(new Error(message), { code }));
  const second = taskListPayload(reads, query, {}, (code, message) => Object.assign(new Error(message), { code }));
  assert.deepEqual(first, second);
  assert.equal(first.payload.schema, "task-list/v2");
  assert.equal(first.payload.mode, "flat");
  assert.deepEqual(first.payload.page, { nextCursor: "cursor-1" });
});

test("task show without a settlement port throws task_not_found", () => {
  const projection = {
    readTaskChildCounts: () => ({ missing: 0 }),
    read: () => ({
      watermark: 1,
      sourceRevision: 1,
      status: "ready",
      snapshot: { task: null, executions: [], revision: 1 },
      packagePath: null,
    }),
    readProgress: () => ({ rows: [], watermark: 1, status: "ready" }),
    getEntity: () => null,
    readTaskIndex: () => ({ rows: [] }),
  } as unknown as TaskProjectionQueries;
  assert.throws(
    () =>
      taskShowFromProjection(
        "D:/harness-stateless-query",
        projection,
        "missing",
        undefined,
        undefined,
        "include_done",
        {},
        {},
      ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "task_not_found",
  );
});
