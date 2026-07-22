// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveTaskProjectionRows,
  taskCreatedAtFromId,
  taskTreeRoots
} from "../../src/projection/task-read-derivations.ts";
import type { TaskProjectionRow } from "../../src/projection/types.ts";

test("ULID task ids expose their millisecond creation time", () => {
  assert.equal(taskCreatedAtFromId("task_01ARZ3NDEKTSV4RRFFQ69G5FAV"), "2016-07-30T23:54:10.259Z");
  assert.equal(taskCreatedAtFromId("task_legacy"), null);
});

test("tree roots follow parents and terminate deterministically on cycles", () => {
  const roots = taskTreeRoots([
    { taskId: "root" },
    { taskId: "child", parentTaskId: "root" },
    { taskId: "grandchild", parentTaskId: "child" },
    { taskId: "cycle-b", parentTaskId: "cycle-a" },
    { taskId: "cycle-a", parentTaskId: "cycle-b" }
  ]);
  assert.equal(roots.get("grandchild"), "root");
  assert.equal(roots.get("cycle-a"), "cycle-a");
  assert.equal(roots.get("cycle-b"), "cycle-a");
});

test("liveness uses lease, progress, and nested package mtimes while excluding terminal tasks", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-recency-"));
  try {
    const now = new Date("2026-07-22T12:00:00.000Z");
    const leaseTask = row("task_01ARZ3NDEKTSV4RRFFQ69G5FAV", "harness/tasks/lease/INDEX.md");
    const progressTask = row("task_01ARZ3NDEKTSV4RRFFQ69G5FAW", "harness/tasks/progress/INDEX.md");
    const packageTask = row("task_01ARZ3NDEKTSV4RRFFQ69G5FAX", "harness/tasks/package/INDEX.md");
    mkdirSync(path.join(rootDir, ".harness/task-holders"), { recursive: true });
    mkdirSync(path.join(rootDir, "harness/tasks/progress"), { recursive: true });
    mkdirSync(path.join(rootDir, "harness/tasks/package/artifacts"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness/task-holders", `${leaseTask.taskId}.json`), JSON.stringify({
      schema: "task-holder/v1",
      taskId: leaseTask.taskId,
      holder: { principal: { personId: "person_test" } },
      leaseExpiresAt: "2026-07-22T13:00:00.000Z",
      releasedAt: null
    }));
    const progressPath = path.join(rootDir, "harness/tasks/progress/progress.md");
    writeFileSync(progressPath, "# Progress\n");
    const progressAt = new Date("2026-07-20T12:00:00.000Z");
    utimesSync(progressPath, progressAt, progressAt);
    const artifactPath = path.join(rootDir, "harness/tasks/package/artifacts/result.txt");
    writeFileSync(artifactPath, "result\n");
    utimesSync(artifactPath, progressAt, progressAt);

    const recent = deriveTaskProjectionRows(rootDir, [leaseTask, progressTask, packageTask], { now });
    assert.deepEqual(recent.map((task) => task.liveness), ["in_flight", "in_flight", "in_flight"]);
    const later = deriveTaskProjectionRows(rootDir, [leaseTask, progressTask, packageTask], { now: new Date("2026-07-24T13:00:00.000Z") });
    assert.deepEqual(later.map((task) => task.liveness), ["stale", "stale", "stale"]);
    const terminal = { ...progressTask, canonicalStatus: "done" as const, coordinationStatus: "terminal" as const };
    assert.equal(deriveTaskProjectionRows(rootDir, [terminal], { now })[0]?.liveness, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function row(taskId: string, sourcePath: string): TaskProjectionRow {
  return {
    schema: "sqlite-task-row/v1",
    taskId,
    title: taskId,
    createdAt: taskCreatedAtFromId(taskId),
    treeRoot: taskId,
    liveness: "stale",
    canonicalStatus: "active",
    coordinationStatus: "open",
    rawStatus: "active",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    lifecycleEngine: "local",
    freshness: "fresh",
    updatedAt: "2026-07-22T00:00:00.000Z",
    source: "local-document",
    sourcePath,
    attribution: { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" }
  };
}
