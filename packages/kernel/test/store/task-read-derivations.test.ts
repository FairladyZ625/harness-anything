// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveTaskProjectionRowsFromSourceCache,
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

test("liveness uses cached task-source mtimes and active leases while excluding terminal tasks", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-recency-"));
  try {
    const now = new Date("2026-07-22T12:00:00.000Z");
    const leaseTask = row("task_01ARZ3NDEKTSV4RRFFQ69G5FAV", "harness/tasks/task_01ARZ3NDEKTSV4RRFFQ69G5FAV-lease/INDEX.md");
    const sourceTask = row("task_01ARZ3NDEKTSV4RRFFQ69G5FAW", "harness/tasks/task_01ARZ3NDEKTSV4RRFFQ69G5FAW-source/INDEX.md");
    const staleTask = row("task_01ARZ3NDEKTSV4RRFFQ69G5FAX", "harness/tasks/task_01ARZ3NDEKTSV4RRFFQ69G5FAX-stale/INDEX.md");
    const terminal = { ...sourceTask, canonicalStatus: "done" as const, coordinationStatus: "terminal" as const };
    mkdirSync(path.join(rootDir, ".harness/task-holders"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness/task-holders", `${leaseTask.taskId}.json`), JSON.stringify({
      schema: "task-holder/v1",
      taskId: leaseTask.taskId,
      holder: { principal: { personId: "person_test" } },
      leaseExpiresAt: "2026-07-22T13:00:00.000Z",
      releasedAt: null
    }));
    const old = statSignature("2026-07-01T00:00:00.000Z");
    const recent = statSignature("2026-07-20T12:00:00.000Z");
    const sourceCache = {
      files: [
        cacheFile(leaseTask, "task-index", old),
        cacheFile(sourceTask, "task-index", old),
        cacheFile(sourceTask, "task-review", recent, "review.md"),
        cacheFile(staleTask, "task-index", old)
      ],
      watches: [],
      metadata: [],
      kindHashes: { task: "task-hash", attribution: "attribution-hash" },
      hash: "cache-hash"
    } as const;

    const derived = deriveTaskProjectionRowsFromSourceCache(
      rootDir,
      [leaseTask, sourceTask, staleTask, terminal],
      sourceCache,
      { now, includeActiveLeases: true }
    );
    assert.deepEqual(derived.map((task) => task.liveness), ["in_flight", "in_flight", "stale", null]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function statSignature(at: string): string {
  return `1:2:3:4:${BigInt(Date.parse(at)) * 1_000_000n}:6`;
}

function cacheFile(
  task: TaskProjectionRow,
  sourceKind: string,
  statSignatureValue: string,
  basename = "INDEX.md"
) {
  return {
    cacheKind: "task" as const,
    sourcePath: path.posix.join(path.posix.dirname(task.sourcePath), basename),
    sourceKind,
    ...(sourceKind === "task-index" ? { ownerId: path.posix.basename(path.posix.dirname(task.sourcePath)) } : {}),
    statSignature: statSignatureValue,
    contentSha256: "sha256:fixture",
    body: "fixture"
  };
}

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
