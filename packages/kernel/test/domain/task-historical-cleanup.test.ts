// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  canEdgeSelfCleanHistoricalTask,
  isHistoricalTaskCleanupAction,
  type ActorIdentity,
  type LeaseV1,
} from "../../src/index.ts";

const owner: ActorIdentity = { principal: { personId: "person_alice" }, executor: null };
const other: ActorIdentity = { principal: { personId: "person_bob" }, executor: null };

function lease(phase: LeaseV1["phase"], actor: ActorIdentity): LeaseV1 {
  return {
    schema: "lease/v1",
    taskId: "task_hist_1",
    executionId: "exe_hist_1",
    actor,
    source: { kind: "node", nodeId: "node-one" },
    phase,
    ttlMs: 60_000,
    expiresAt: "2026-11-27T01:00:00.000Z",
    version: 1,
  };
}

test("isHistoricalTaskCleanupAction matches only the four cleanup actions and excludes consent/ordinary complete", () => {
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-release" }), true);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-archive" }), true);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-transition", status: "cancelled" }), true);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-complete", resolvedBy: "task_done_1" }), true);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-complete", resolvedBy: "a".repeat(40) }), true);

  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-transition", status: "active" }), false);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-transition", status: "planned" }), false);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-transition", status: "blocked" }), false);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-complete" }), false);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-complete", resolvedBy: "   " }), false);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-review-consent" }), false);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "task-submit" }), false);
  assert.equal(isHistoricalTaskCleanupAction({ kind: "doc-submit" }), false);
});

test("canEdgeSelfCleanHistoricalTask admits own unleased or own expired-orphaned tasks and blocks live/foreign boundaries", () => {
  const ownTask = { createdBy: owner };
  const foreignTask = { createdBy: other };
  const cleanupActions = [
    { kind: "task-release" },
    { kind: "task-archive" },
    { kind: "task-transition", status: "cancelled" },
    { kind: "task-complete", resolvedBy: "task_resolved_1" },
  ] as const;

  for (const action of cleanupActions) {
    // Positive: own task with no lease, released lease, or own expired orphaned lease.
    assert.equal(
      canEdgeSelfCleanHistoricalTask({ action, task: ownTask, lease: null, actor: owner }),
      true,
      `${action.kind} unleased own task`,
    );
    assert.equal(
      canEdgeSelfCleanHistoricalTask({
        action,
        task: ownTask,
        lease: lease("released", owner),
        actor: owner,
      }),
      true,
      `${action.kind} own released lease`,
    );
    assert.equal(
      canEdgeSelfCleanHistoricalTask({
        action,
        task: ownTask,
        lease: lease("orphaned", owner),
        actor: owner,
      }),
      true,
      `${action.kind} own orphaned lease`,
    );

    // Negative: live unexpired held/reserving leases (own or foreign).
    assert.equal(
      canEdgeSelfCleanHistoricalTask({ action, task: ownTask, lease: lease("held", owner), actor: owner }),
      false,
      `${action.kind} own active held lease`,
    );
    assert.equal(
      canEdgeSelfCleanHistoricalTask({ action, task: ownTask, lease: lease("held", other), actor: owner }),
      false,
      `${action.kind} foreign active held lease`,
    );
    assert.equal(
      canEdgeSelfCleanHistoricalTask({ action, task: ownTask, lease: lease("reserving", owner), actor: owner }),
      false,
      `${action.kind} reserving lease`,
    );

    // Negative: foreign orphaned lease or foreign task ownership.
    assert.equal(
      canEdgeSelfCleanHistoricalTask({ action, task: ownTask, lease: lease("orphaned", other), actor: owner }),
      false,
      `${action.kind} foreign orphaned lease`,
    );
    assert.equal(
      canEdgeSelfCleanHistoricalTask({ action, task: foreignTask, lease: null, actor: owner }),
      false,
      `${action.kind} foreign task`,
    );
    assert.equal(
      canEdgeSelfCleanHistoricalTask({ action, task: null, lease: null, actor: owner }),
      false,
      `${action.kind} missing task`,
    );
  }

  // Negative: review-consent and ordinary complete are never admitted.
  assert.equal(
    canEdgeSelfCleanHistoricalTask({
      action: { kind: "task-review-consent" },
      task: ownTask,
      lease: null,
      actor: owner,
    }),
    false,
  );
  assert.equal(
    canEdgeSelfCleanHistoricalTask({ action: { kind: "task-complete" }, task: ownTask, lease: null, actor: owner }),
    false,
  );
});
