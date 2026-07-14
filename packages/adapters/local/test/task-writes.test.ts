// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { taskEntityId } from "../../../kernel/src/index.ts";
import type { WriteCoordinator, WriteOp } from "../../../kernel/src/index.ts";
import { makeLocalLifecycleEngine } from "../src/index.ts";
import { writeSupersedeTaskDocuments } from "../src/task-writes.ts";

const executionTaskId = "task_01KX7H00000000000000000000";

test("supersede document writes use the explicit operation task id", () => {
  const enqueued: WriteOp[] = [];
  const coordinator: WriteCoordinator = {
    enqueue: (op) => Effect.sync(() => {
      enqueued.push(op);
      return { opId: op.opId, entityId: op.entityId, accepted: true };
    }),
    flush: () => Effect.succeed({ reason: "explicit", opCount: enqueued.length, committed: true }),
    recover: Effect.succeed({ replayedOps: 0 })
  };

  Effect.runSync(writeSupersedeTaskDocuments(coordinator, stableHash, "task-old", [
    { taskId: "task-new", path: "INDEX.md", body: "replacement" }
  ]));

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.entityId, taskEntityId("task-old"));
  assert.equal(enqueued[0]?.kind, "package_supersede");
});

for (const status of ["in_review", "done"] as const) {
  test(`generic local status writer rejects ${status} outside the Execution aggregate`, () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-status-gate-"));
    const enqueued: WriteOp[] = [];
    try {
      writeTaskIndex(rootDir, "active");
      const engine = makeLocalLifecycleEngine({ rootDir, coordinator: capturingCoordinator(enqueued) });

      const failure = Effect.runSync(Effect.flip(engine.setStatus({ taskId: executionTaskId, status })));

      assert.equal(failure._tag, "WriteRejected");
      if (failure._tag === "WriteRejected") {
        assert.equal(failure.code, status === "in_review" ? "execution_submission_required" : "execution_completion_required");
      }
      assert.equal(enqueued.length, 0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test("generic local status writer rejects exits from in_review outside the Execution Review aggregate", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-status-gate-"));
  const enqueued: WriteOp[] = [];
  try {
    writeTaskIndex(rootDir, "in_review");
    const engine = makeLocalLifecycleEngine({ rootDir, coordinator: capturingCoordinator(enqueued) });

    for (const status of ["active", "blocked"] as const) {
      const failure = Effect.runSync(Effect.flip(engine.setStatus({ taskId: executionTaskId, status })));
      assert.equal(failure._tag, "WriteRejected");
      if (failure._tag === "WriteRejected") assert.equal(failure.code, "execution_review_required");
    }
    assert.equal(enqueued.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function capturingCoordinator(enqueued: WriteOp[]): WriteCoordinator {
  return {
    enqueue: (op) => Effect.sync(() => {
      enqueued.push(op);
      return { opId: op.opId, entityId: op.entityId, accepted: true };
    }),
    flush: () => Effect.succeed({ reason: "explicit", opCount: enqueued.length, committed: true }),
    recover: Effect.succeed({ replayedOps: 0 })
  };
}

function writeTaskIndex(rootDir: string, status: "active" | "in_review"): void {
  const taskRoot = path.join(rootDir, "harness/tasks", executionTaskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${executionTaskId}`,
    "title: Execution Task",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    "  titleSnapshot: Execution Task",
    "  url: ",
    "  bindingCreatedAt: 2026-07-11T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: standard-task",
    "provenance:",
    "  - {runtime: human, sessionId: human-test, boundAt: 2026-07-11T00:00:00.000Z}",
    "---",
    "",
    "# Execution Task",
    ""
  ].join("\n"), "utf8");
}

function stableHash(value: unknown): string {
  return JSON.stringify(value);
}
