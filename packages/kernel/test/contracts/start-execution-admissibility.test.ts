// harness-test-tier: contract
import assert from "node:assert/strict";
import { test } from "node:test";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { submissionDigest } from "../../src/domain/execution.ts";
import {
  applyTransition,
  canStartExecution,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  validateTransition,
  type CreateReplayTaskProof,
  type StartExecutionProof,
  type SubmitExecutionProof,
  type TaskLifecycleCommand,
  type TaskLifecycleSnapshot,
} from "../../src/domain/task-lifecycle.contract.ts";
import type { ActorAxes } from "../../src/domain/task.ts";

const implementer: ActorAxes = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } };

function command<C extends Parameters<typeof normalizeTaskLifecycleCommand>[1]>(
  revision: number,
  intent: C,
  actor: ActorAxes = implementer,
) {
  return {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor, source: "local", expectedRevision: revision - 1 },
      intent,
    ),
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    occurredAt: `2026-08-17T00:0${revision - 1}:00.000Z`,
  };
}

function apply(
  snapshot: TaskLifecycleSnapshot,
  next: TaskLifecycleCommand,
  proof: CreateReplayTaskProof | StartExecutionProof | SubmitExecutionProof,
): TaskLifecycleSnapshot {
  return applyTransition(snapshot, next, proof as never).snapshot;
}

/** A task that has been created but never started: no execution exists yet. */
function planned(): TaskLifecycleSnapshot {
  return apply(
    emptyTaskLifecycleSnapshot(),
    command(1, {
      type: "CreateReplayTask",
      taskId: "task-1",
      title: "Fixture",
      taskClass: "standard",
      graph: REPLAY_TASK_GRAPH,
      completionGateIds: [],
      presetSnapshotDigest: null,
    }) as TaskLifecycleCommand,
    { taskIdUnique: true, actorBinding: implementer },
  );
}

/** A task with one active execution and a held lease. */
function started(): TaskLifecycleSnapshot {
  return apply(
    planned(),
    command(2, { type: "StartExecution", taskId: "task-1", executionId: "execution-1" }) as TaskLifecycleCommand,
    {
      actorBinding: implementer,
      reservation: {
        taskId: "task-1",
        executionId: "execution-1",
        expiresAt: "2026-08-17T01:00:00.000Z",
        ttlMs: 1_800_000,
        previousHolder: null,
        reason: "initial_claim",
        version: 0,
      },
    },
  );
}

function submitted(): TaskLifecycleSnapshot {
  return apply(
    started(),
    command(3, {
      type: "SubmitExecution",
      taskId: "task-1",
      executionId: "execution-1",
      submission: {
        completionClaim: "Implementation complete",
        deliverables: ["repair"],
        outputs: ["commit"],
        verificationNotes: ["contract test"],
        knownGaps: [],
        residualRisks: [],
        commitSha: "a".repeat(40),
      },
    }) as TaskLifecycleCommand,
    { actorBinding: implementer, leaseVersion: 0, sessionDisposition: "complete" },
  );
}

function amendment(
  snapshot: TaskLifecycleSnapshot,
  actor: ActorAxes = implementer,
  completionClaim = "Corrected implementation",
) {
  return command(
    snapshot.revision + 1,
    {
      type: "SubmitExecution",
      taskId: "task-1",
      executionId: "execution-1",
      amend: true,
      submission: {
        completionClaim,
        deliverables: ["repair"],
        outputs: ["commit"],
        verificationNotes: ["contract test"],
        knownGaps: [],
        residualRisks: [],
        commitSha: "b".repeat(40),
      },
    },
    actor,
  ) as TaskLifecycleCommand;
}

/** A review-node task whose only execution relation was retired from the projection. */
function strandedInReview(status: "planned" | "active" | "in_review" = "active"): TaskLifecycleSnapshot {
  const snapshot = planned();
  return {
    ...snapshot,
    task: { ...snapshot.task!, status, currentNode: "review" },
    executions: [],
    lease: null,
  };
}

function hasTransitionIssue(snapshot: TaskLifecycleSnapshot, intent: Parameters<typeof command>[1]): boolean {
  return validateTransition(snapshot, command(snapshot.revision + 1, intent) as TaskLifecycleCommand, {} as never).some(
    ({ code }) => code === "invalid_transition",
  );
}

test("a fresh task admits any execution id", () => {
  assert.equal(canStartExecution(planned(), "execution-1"), true);
  assert.equal(canStartExecution(planned(), "anything-else"), true);
  assert.equal(canStartExecution(planned(), ""), false, "an empty execution id is never admissible");
});

test("a held lease blocks StartExecution regardless of the execution id", () => {
  const held = started();
  assert.equal(held.lease?.phase, "held", "fixture precondition: the lease is held");
  assert.equal(canStartExecution(held, "execution-1"), false);
  assert.equal(canStartExecution(held, "execution-fresh"), false);
});

test("a submitted execution preserves review integrity and blocks StartExecution", () => {
  const review = submitted();
  assert.equal(review.task?.status, "in_review");
  assert.equal(review.task?.currentNode, "review");
  assert.equal(review.executions[0]?.state, "submitted");
  assert.equal(canStartExecution(review, "execution-1"), false);
  assert.equal(canStartExecution(review, "execution-fresh"), false);
});

test("a review node with no submitted execution recovers exclusively through StartExecution", () => {
  for (const status of ["planned", "active", "in_review"] as const) {
    const stranded = strandedInReview(status),
      startIntent = {
        type: "StartExecution",
        taskId: "task-1",
        executionId: "execution-recovery",
      } as const,
      submitIntent = {
        type: "SubmitExecution",
        taskId: "task-1",
        executionId: "execution-recovery",
        submission: {
          completionClaim: "Recovered execution complete",
          deliverables: ["repair"],
          outputs: ["commit"],
          verificationNotes: ["contract test"],
          knownGaps: [],
          residualRisks: [],
          commitSha: "a".repeat(40),
        },
      } as const,
      reviewIntent = {
        type: "RecordReview",
        taskId: "task-1",
        executionId: "execution-recovery",
        reviewId: "review-recovery",
        verdict: "approved",
        reason: "reviewed",
        evidenceChecked: ["contract test"],
        commitSha: "a".repeat(40),
        iteration: 0,
        contentDigest: `sha256:${"b".repeat(64)}`,
        submissionDigest: submissionDigest(submitIntent.submission),
      } as const,
      completeIntent = {
        type: "CompleteTask",
        taskId: "task-1",
        executionId: "execution-recovery",
      } as const;

    assert.equal(hasTransitionIssue(stranded, startIntent), false, `${status}/review must admit recovery start`);
    assert.equal(hasTransitionIssue(stranded, submitIntent), true, "submit still requires the recovered execution");
    assert.equal(hasTransitionIssue(stranded, reviewIntent), true, "review still requires a submission");
    assert.equal(hasTransitionIssue(stranded, completeIntent), true, "complete still requires approved consent");

    const recovered = apply(stranded, command(stranded.revision + 1, startIntent) as TaskLifecycleCommand, {
      actorBinding: implementer,
      reservation: {
        taskId: "task-1",
        executionId: "execution-recovery",
        expiresAt: "2026-08-17T01:00:00.000Z",
        ttlMs: 1_800_000,
        previousHolder: null,
        reason: "initial_claim",
        version: 0,
      },
    });
    assert.equal(recovered.task?.status, "active");
    assert.equal(recovered.task?.currentNode, "implementation");
    assert.equal(hasTransitionIssue(recovered, submitIntent), false, "the normal submit path is reachable again");
  }
});

test("two edge commands with the same expected version cannot both commit", () => {
  const initial = planned(),
    candidate = command(2, {
      type: "StartExecution",
      taskId: "task-1",
      executionId: "execution-1",
    }) as TaskLifecycleCommand,
    proof: StartExecutionProof = {
      actorBinding: implementer,
      reservation: {
        taskId: "task-1",
        executionId: "execution-1",
        expiresAt: "2026-08-17T01:00:00.000Z",
        ttlMs: 1_800_000,
        previousHolder: null,
        reason: "initial_claim",
        version: 0,
      },
    },
    winner = applyTransition(initial, candidate, proof).snapshot,
    loserIssues = validateTransition(winner, candidate, proof);
  assert.ok(
    loserIssues.some(({ message }) => message.includes("expected revision")),
    JSON.stringify(loserIssues),
  );
  assert.equal(winner.revision, 2);
});

test("a submission amendment rejects a live lease with invalid_proof", () => {
  const current = submitted(),
    inconsistentLease = { ...current, lease: started().lease },
    next = amendment(inconsistentLease);
  assert.throws(
    () =>
      applyTransition(inconsistentLease, next, {
        actorBinding: implementer,
        leaseVersion: null,
        sessionDisposition: "complete",
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "invalid_proof",
  );
});

test("a submission amendment rejects another execution actor with invalid_proof", () => {
  const current = submitted(),
    otherActor: ActorAxes = {
      principal: implementer.principal,
      executor: { kind: "agent", id: "other-worker" },
    },
    next = amendment(current, otherActor);
  assert.throws(
    () =>
      applyTransition(current, next, {
        actorBinding: otherActor,
        leaseVersion: null,
        sessionDisposition: "complete",
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "invalid_proof",
  );
});

test("a no-op submission amendment rejects with invalid_transition", () => {
  const current = submitted(),
    existing = current.executions[0];
  if (!existing?.submission) throw new Error("submitted fixture has no packet");
  const next = command(current.revision + 1, {
    type: "SubmitExecution",
    taskId: "task-1",
    executionId: "execution-1",
    amend: true,
    submission: existing.submission,
  }) as TaskLifecycleCommand;
  assert.throws(
    () =>
      applyTransition(current, next, {
        actorBinding: implementer,
        leaseVersion: null,
        sessionDisposition: "complete",
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "invalid_transition",
  );
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
    "allocating a fresh id cannot be admitted while an active execution exists — the daemon preview used to hardcode admissible:true here",
  );
});

// The lease the time-aware projection serves after TTL: still the stored CAS row, but with the
// derived phase `orphaned`. Before the fix this object kept `!snapshot.lease` false and blocked
// every `ha task start` form on a current-round execution whose holder was gone (T1-random-baseline).
test("an orphaned expired lease no longer blocks rejoining the round's active execution", () => {
  const orphaned: TaskLifecycleSnapshot = {
    ...started(),
    lease: { ...(started().lease as NonNullable<TaskLifecycleSnapshot["lease"]>), phase: "orphaned" },
  };
  assert.equal(orphaned.lease?.phase, "orphaned", "fixture precondition: the projection-derived phase");

  assert.equal(
    canStartExecution(orphaned, "execution-1"),
    true,
    "an expired lease must not gate the round its execution still holds",
  );
  assert.equal(
    canStartExecution(orphaned, "execution-fresh"),
    false,
    "a fresh id still cannot be admitted while the round's execution is active",
  );
});

test("a different actor takes over the orphaned lease and inherits the execution", () => {
  const orphaned: TaskLifecycleSnapshot = {
      ...started(),
      lease: { ...(started().lease as NonNullable<TaskLifecycleSnapshot["lease"]>), phase: "orphaned" },
    },
    peer: ActorAxes = { principal: { personId: "person-peer" }, executor: { kind: "agent", id: "peer-worker" } },
    // The daemon reservation CAS fences the takeover: reserving v1, held v2 on top of the orphaned v0.
    applied = applyTransition(
      orphaned,
      command(
        3,
        { type: "StartExecution", taskId: "task-1", executionId: "execution-1" },
        peer,
      ) as TaskLifecycleCommand,
      {
        actorBinding: peer,
        reservation: {
          taskId: "task-1",
          executionId: "execution-1",
          expiresAt: "2026-08-17T01:30:00.000Z",
          ttlMs: 1_800_000,
          previousHolder: { taskId: "task-1", executionId: "execution-1", actor: implementer, source: "local" },
          reason: "ttl_expired_takeover",
          version: 2,
        },
      },
    ),
    { snapshot: taken, event } = applied;

  assert.equal(taken.lease?.phase, "held");
  assert.equal(taken.lease?.version, 2, "the takeover lease continues the orphaned CAS version chain");
  assert.deepEqual(taken.lease?.actor, peer);
  assert.equal(taken.executions.length, 1);
  assert.deepEqual(taken.executions[0]?.actor, peer, "the execution is inherited, not replaced");
  assert.deepEqual(event.payload.previousHolder, {
    taskId: "task-1",
    executionId: "execution-1",
    actor: implementer,
    source: "local",
  });
  assert.equal(event.payload.reason, "ttl_expired_takeover");
});

// The 14-task closeout deadlock shape: the lease is released, ReturnToPlanned resets the status,
// but the still-active execution keeps claiming the round, so no fresh execution can ever start.
test("ReturnToPlanned closes the open round so a fresh execution can start", () => {
  const released: TaskLifecycleSnapshot = { ...started(), lease: null },
    returned = apply(
      released,
      command(3, {
        type: "TransitionTask",
        taskId: "task-1",
        status: "planned",
        reason: "Reset the round",
      }) as TaskLifecycleCommand,
      {} as never,
    );

  assert.equal(returned.task?.status, "planned");
  assert.equal(returned.task?.iteration, 1, "the open execution round is closed by round advancement");
  assert.equal(returned.executions[0]?.state, "active", "the execution record itself is left untouched");
  assert.equal(
    canStartExecution(returned, "execution-fresh"),
    true,
    "a fresh execution must be allocatable after the round is returned to planned",
  );
  assert.equal(
    canStartExecution(returned, "execution-1"),
    false,
    "the returned round's execution is closed and no longer rejoinable",
  );
});

test("ReturnToPlanned without an open round keeps the iteration", () => {
  const idle: TaskLifecycleSnapshot = { ...started(), executions: [], lease: null },
    returned = apply(
      idle,
      command(3, {
        type: "TransitionTask",
        taskId: "task-1",
        status: "planned",
        reason: "Reset the round",
      }) as TaskLifecycleCommand,
      {} as never,
    );

  assert.equal(returned.task?.iteration, 0);
  assert.equal(canStartExecution(returned, "execution-fresh"), true);
});

test("rejoining an active execution transfers its attribution to the new lease holder", () => {
  const expired: TaskLifecycleSnapshot = { ...started(), lease: null },
    runtimeActor: ActorAxes = {
      principal: implementer.principal,
      executor: { kind: "agent", id: "runtime-session:runtime-handoff" },
    },
    rejoined = apply(
      expired,
      command(
        3,
        { type: "StartExecution", taskId: "task-1", executionId: "execution-1" },
        runtimeActor,
      ) as TaskLifecycleCommand,
      {
        actorBinding: runtimeActor,
        reservation: {
          taskId: "task-1",
          executionId: "execution-1",
          expiresAt: "2026-08-17T01:30:00.000Z",
          ttlMs: 1_800_000,
          previousHolder: null,
          reason: "rejoin",
          version: 1,
        },
      },
    );

  assert.equal(rejoined.executions.length, 1);
  assert.deepEqual(rejoined.executions[0]?.actor, runtimeActor);
  assert.deepEqual(rejoined.lease?.actor, runtimeActor);
});
