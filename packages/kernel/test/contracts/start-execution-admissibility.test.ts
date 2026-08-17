// harness-test-tier: contract
import assert from "node:assert/strict";
import { test } from "node:test";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import {
  applyTransition,
  canStartExecution,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  type CreateReplayTaskProof,
  type StartExecutionProof,
  type TaskLifecycleCommand,
  type TaskLifecycleSnapshot
} from "../../src/domain/task-lifecycle.contract.ts";
import type { ActorAxes } from "../../src/domain/task.ts";

const implementer: ActorAxes = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } };

function command<C extends Parameters<typeof normalizeTaskLifecycleCommand>[1]>(revision: number, intent: C) {
  return {
    ...normalizeTaskLifecycleCommand({ workspaceId: "workspace-1", actor: implementer, source: "local", expectedRevision: revision - 1 }, intent),
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    occurredAt: `2026-08-17T00:0${revision - 1}:00.000Z`
  };
}

function apply(snapshot: TaskLifecycleSnapshot, next: TaskLifecycleCommand, proof: CreateReplayTaskProof | StartExecutionProof): TaskLifecycleSnapshot {
  return applyTransition(snapshot, next, proof as never).snapshot;
}

/** A task that has been created but never started: no execution exists yet. */
function planned(): TaskLifecycleSnapshot {
  return apply(emptyTaskLifecycleSnapshot(), command(1, {
    type: "CreateReplayTask", taskId: "task-1", title: "Fixture", taskClass: "standard", graph: REPLAY_TASK_GRAPH, completionGateIds: [], presetSnapshotDigest: null
  }) as TaskLifecycleCommand, { taskIdUnique: true, actorBinding: implementer });
}

/** A task with one active execution and a held lease. */
function started(): TaskLifecycleSnapshot {
  return apply(planned(), command(2, { type: "StartExecution", taskId: "task-1", executionId: "execution-1" }) as TaskLifecycleCommand, {
    actorBinding: implementer,
    reservation: { taskId: "task-1", executionId: "execution-1", expiresAt: "2026-08-17T01:00:00.000Z", ttlMs: 1_800_000, previousHolder: null, reason: "initial_claim", version: 0 }
  });
}

test("a fresh task admits any execution id", () => {
  assert.equal(canStartExecution(planned(), "execution-1"), true);
  assert.equal(canStartExecution(planned(), "anything-else"), true);
  assert.equal(canStartExecution(planned(), ""), false, "an empty execution id is never admissible");
});

test("a held lease blocks StartExecution regardless of the execution id", () => {
  const held = started();
  assert.equal(held.lease?.phase, "active", "fixture precondition: the lease is held");
  assert.equal(canStartExecution(held, "execution-1"), false);
  assert.equal(canStartExecution(held, "execution-fresh"), false);
});

// The reported failure: the lease expires silently, `progress append` tells you to run `task start`,
// and `task start` then rejects. The only way back in is to rejoin the execution that is still active.
test("after the lease expires, only rejoining the round's active execution is admissible", () => {
  const expired: TaskLifecycleSnapshot = { ...started(), lease: null };
  const active = expired.executions.find((value) => value.state === "active");
  assert.equal(active?.executionId, "execution-1", "fixture precondition: the execution survived the lease");

  assert.equal(canStartExecution(expired, "execution-1"), true, "rejoining the active execution is the way back in");
  assert.equal(
    canStartExecution(expired, "execution-fresh"),
    false,
    "allocating a fresh id cannot be admitted while an active execution exists — the daemon preview used to hardcode admissible:true here"
  );
});
