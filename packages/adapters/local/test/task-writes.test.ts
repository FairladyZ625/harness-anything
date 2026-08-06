// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { taskEntityId } from "../../../kernel/src/index.ts";
import type { WriteCoordinator, WriteError, WriteOp } from "../../../kernel/src/index.ts";
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

test("local task create preserves a structured provenance write rejection", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-create-rejection-"));
  const enqueued: WriteOp[] = [];
  const rejection = semanticWriteRejection();
  try {
    const engine = makeLocalLifecycleEngine({
      rootDir,
      coordinator: capturingCoordinator(enqueued),
      bindCreateProvenance: () => Effect.fail({ reason: rejection.reason, writeError: rejection })
    });

    const failure = Effect.runSync(Effect.flip(engine.createTask({
      taskId: executionTaskId,
      title: "Rejected create",
      allowManualId: false
    })));

    assert.equal(failure, rejection);
    assert.equal(enqueued.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local task supersede preserves a structured provenance write rejection", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-supersede-rejection-"));
  const enqueued: WriteOp[] = [];
  const rejection = semanticWriteRejection();
  try {
    writeTaskIndex(rootDir, "active");
    const engine = makeLocalLifecycleEngine({
      rootDir,
      coordinator: capturingCoordinator(enqueued),
      bindCreateProvenance: () => Effect.fail({ reason: rejection.reason, writeError: rejection })
    });

    const failure = Effect.runSync(Effect.flip(engine.supersedeTask({
      oldTaskId: executionTaskId,
      newTaskId: "task_01KX7H00000000000000000001",
      title: "Rejected supersede",
      slug: "rejected-supersede",
      reason: "fixture"
    })));

    assert.equal(failure, rejection);
    assert.equal(enqueued.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const status of ["in_review", "done"] as const) {
  test(`generic local status writer rejects ${status} outside the Execution aggregate`, () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-status-gate-"));
    const enqueued: WriteOp[] = [];
    try {
      writeTaskIndex(rootDir, "active");
      const engine = makeLocalLifecycleEngine({ rootDir, coordinator: capturingCoordinator(enqueued) });

      const failure = Effect.runSync(Effect.flip(engine.setStatus({ taskId: executionTaskId, status })));

      assert.equal(failure._tag, "InvalidTransition");
      assert.equal(enqueued.length, 0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test("generic local status writer rejects non-cancellation exits from in_review", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-status-gate-"));
  const enqueued: WriteOp[] = [];
  try {
    writeTaskIndex(rootDir, "in_review");
    const engine = makeLocalLifecycleEngine({ rootDir, coordinator: capturingCoordinator(enqueued) });

    for (const status of ["active", "blocked"] as const) {
      const failure = Effect.runSync(Effect.flip(engine.setStatus({ taskId: executionTaskId, status })));
      assert.equal(failure._tag, "InvalidTransition");
    }
    assert.equal(enqueued.length, 0);

    const auditText = "FORCE_STATUS_SET_AUDIT: forced terminal status=cancelled; reason=test; recordedAt=2026-08-01T00:00:00.000Z";
    const cancelled = Effect.runSync(engine.setStatus({
      taskId: executionTaskId,
      status: "cancelled",
      auditText
    }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]?.kind, "transition_local");
    assert.equal((enqueued[0]?.payload as { readonly auditText?: string }).auditText, auditText);
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

function semanticWriteRejection(): Extract<WriteError, { readonly _tag: "WriteRejected" }> {
  return {
    _tag: "WriteRejected",
    code: "authored_root_not_isolated",
    reason: "authored root is not isolated",
    retryable: false
  };
}
