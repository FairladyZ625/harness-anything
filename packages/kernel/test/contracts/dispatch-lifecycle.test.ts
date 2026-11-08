// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  DispatchLifecycleError,
  emptyDispatchLifecycleProjection,
  migrateUnclosedDispatchGroup,
  readDispatchLifecycle,
  rebuildDispatchLifecycle,
  reduceDispatchLifecycle,
  type DispatchLifecycleAttempt,
  type DispatchLifecycleEvent,
  type DispatchLifecycleProjection,
} from "../../src/domain/dispatch-lifecycle.ts";
import { validateAgentRuntimePayload } from "../../src/domain/agent-runtime.ts";

const fence = { ownerId: "node-a", epoch: 4 } as const;
const event = (type: DispatchLifecycleEvent["type"], overrides: Record<string, unknown> = {}): DispatchLifecycleEvent =>
  ({
    schema: "dispatch-lifecycle-event/v1",
    source: "center",
    eventId: `event-${String(overrides.eventId ?? type)}`,
    repoId: "repo-a",
    attemptGroupId: "group-a",
    dispatchId: "dispatch-a",
    expectedGroupVersion: 0,
    ownerFence: fence,
    type,
    ...(type === "dispatch_admitted"
      ? {
          instanceId: "instance-a",
          runtimeSessionId: "runtime-a",
          reservationId: "reservation-a",
          capacityLimit: 1,
        }
      : {}),
    ...overrides,
  }) as DispatchLifecycleEvent;

function apply(
  projection: DispatchLifecycleProjection,
  value: DispatchLifecycleEvent,
  revision: number,
): DispatchLifecycleProjection {
  return reduceDispatchLifecycle(projection, value, revision).projection;
}

function runningProjection(): DispatchLifecycleProjection {
  let projection = apply(emptyDispatchLifecycleProjection(), event("dispatch_admitted"), 1);
  projection = apply(projection, event("process_started", { expectedGroupVersion: 1, eventId: "started" }), 2);
  return projection;
}

test("dispatch lifecycle rejects illegal transitions and keeps capacity until stop proof", () => {
  const admitted = apply(emptyDispatchLifecycleProjection(), event("dispatch_admitted"), 1);
  assert.throws(
    () =>
      reduceDispatchLifecycle(
        admitted,
        event("settlement_committed", { expectedGroupVersion: 1, outcome: "succeeded" }),
        2,
      ),
    { name: "DispatchLifecycleError", code: "invalid_transition" },
  );
  const exited = apply(admitted, event("process_started", { expectedGroupVersion: 1, eventId: "start" }), 2),
    settling = apply(exited, event("process_exit", { expectedGroupVersion: 2, eventId: "exit" }), 3);
  assert.equal(settling.groups["group-a"]?.attempts[0]?.capacity, "held");
  assert.throws(
    () =>
      reduceDispatchLifecycle(
        settling,
        event("settlement_committed", { expectedGroupVersion: 3, outcome: "succeeded" }),
        4,
      ),
    { name: "DispatchLifecycleError", code: "invalid_transition" },
  );
  const stopped = apply(
    settling,
    event("process_stop_proven", {
      expectedGroupVersion: 3,
      eventId: "stopped",
      proof: "proven_stopped",
    }),
    4,
  );
  assert.equal(stopped.groups["group-a"]?.attempts[0]?.capacity, "released");
  const closed = apply(
    stopped,
    event("settlement_committed", { expectedGroupVersion: 4, eventId: "closed", outcome: "succeeded" }),
    5,
  );
  assert.equal(closed.groups["group-a"]?.phase, "closed");
  assert.deepEqual(closed.activeReservationsByInstance["instance-a"], []);
});

test("dispatch lifecycle event ids are idempotent and reject conflicting reuse", () => {
  const first = event("dispatch_admitted", { eventId: "admit" }),
    projection = apply(emptyDispatchLifecycleProjection(), first, 1),
    duplicate = reduceDispatchLifecycle(projection, first, 2);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.projection, projection);
  assert.throws(
    () =>
      reduceDispatchLifecycle(
        projection,
        event("dispatch_admitted", { eventId: "admit", runtimeSessionId: "runtime-other" }),
        2,
      ),
    { name: "DispatchLifecycleError", code: "duplicate_event_conflict" },
  );
});

test("runtime lifecycle observations bind the envelope session identity", () => {
  const lifecycle = event("dispatch_admitted");
  assert.deepEqual(
    validateAgentRuntimePayload("runtime_dispatch_lifecycle_observed", {
      runtimeSessionId: "runtime-other",
      lifecycle,
    }),
    ["dispatch lifecycle observation is invalid"],
  );
  assert.deepEqual(
    validateAgentRuntimePayload("runtime_dispatch_lifecycle_observed", {
      runtimeSessionId: "runtime-a",
      lifecycle,
    }),
    [],
  );
});

test("dispatch lifecycle rejects old owner epochs and stale group versions", () => {
  const projection = runningProjection();
  assert.throws(
    () =>
      reduceDispatchLifecycle(
        projection,
        event("process_exit", {
          expectedGroupVersion: 2,
          eventId: "old-epoch",
          ownerFence: { ownerId: "node-a", epoch: 3 },
        }),
        3,
      ),
    (error: unknown) => error instanceof DispatchLifecycleError && error.code === "stale_owner_fence",
  );
  assert.throws(() => reduceDispatchLifecycle(projection, event("process_exit", { expectedGroupVersion: 1 }), 3), {
    name: "DispatchLifecycleError",
    code: "stale_group_version",
  });
});

test("restart adoption renews the owner fence once without regressing an accepted phase", () => {
  const admitted = apply(emptyDispatchLifecycleProjection(), event("dispatch_admitted"), 1),
    restarted = { ownerId: "node-a-restarted", epoch: fence.epoch + 1 },
    adopted = apply(
      admitted,
      event("adopted_process_observed", {
        expectedGroupVersion: 1,
        eventId: "adopted",
        ownerFence: restarted,
        process: "alive",
      }),
      2,
    );
  // A live starting attempt whose process_started was lost is confirmed running by adoption.
  assert.equal(adopted.groups["group-a"]?.phase, "running");
  assert.equal(adopted.groups["group-a"]?.attempts[0]?.capacity, "held");
  assert.deepEqual(adopted.groups["group-a"]?.ownerFence, restarted);
  // The previous owner can no longer publish once a newer epoch adopted the attempt.
  assert.throws(
    () => reduceDispatchLifecycle(adopted, event("process_exit", { expectedGroupVersion: 2, eventId: "old" }), 3),
    { name: "DispatchLifecycleError", code: "stale_owner_fence" },
  );
  assert.throws(
    () =>
      reduceDispatchLifecycle(
        adopted,
        event("adopted_process_observed", {
          expectedGroupVersion: 2,
          eventId: "older-adopt",
          ownerFence: { ownerId: "node-a-older", epoch: fence.epoch - 1 },
          process: "alive",
        }),
        3,
      ),
    { name: "DispatchLifecycleError", code: "stale_owner_fence" },
  );
  const lost = apply(
    adopted,
    event("process_lost", { expectedGroupVersion: 2, eventId: "lost", ownerFence: restarted }),
    3,
  );
  const readopted = apply(
    lost,
    event("adopted_process_observed", {
      expectedGroupVersion: 3,
      eventId: "readopted",
      ownerFence: { ownerId: "node-a-third", epoch: fence.epoch + 2 },
      process: "alive",
    }),
    4,
  );
  assert.equal(readopted.groups["group-a"]?.phase, "settling", "adoption never returns settling to running");
  assert.equal(readopted.groups["group-a"]?.attempts[0]?.process, "lost");
  assert.equal(
    readDispatchLifecycle(readopted, { by: "session", runtimeSessionId: "runtime-a" }).rows[0]?.groupVersion,
    4,
  );
});

test("single-writer admission grants only one reservation for an instance capacity slot", () => {
  const first = event("dispatch_admitted"),
    second = event("dispatch_admitted", {
      eventId: "other-admit",
      attemptGroupId: "group-b",
      dispatchId: "dispatch-b",
      runtimeSessionId: "runtime-b",
      reservationId: "reservation-b",
    }),
    projection = apply(emptyDispatchLifecycleProjection(), first, 1);
  assert.throws(() => reduceDispatchLifecycle(projection, second, 2), {
    name: "DispatchLifecycleError",
    code: "instance_capacity_exhausted",
  });
});

test("online projection, cold rebuild, and bounded lifecycle reads agree", () => {
  const events = [
    event("dispatch_admitted"),
    event("process_started", { expectedGroupVersion: 1, eventId: "started" }),
    event("process_exit", { expectedGroupVersion: 2, eventId: "exit" }),
    event("process_stop_proven", {
      expectedGroupVersion: 3,
      eventId: "stopped",
      proof: "proven_stopped",
    }),
    event("settlement_committed", {
      expectedGroupVersion: 4,
      eventId: "closed",
      outcome: "succeeded",
    }),
  ];
  let online = emptyDispatchLifecycleProjection();
  events.forEach((value, index) => (online = apply(online, value, index + 1)));
  const rebuilt = events.reduce(
    (projection, value, index) => reduceDispatchLifecycle(projection, value, index + 1).projection,
    emptyDispatchLifecycleProjection(),
  );
  assert.deepEqual(rebuilt, online);
  assert.deepEqual(readDispatchLifecycle(online, { by: "dispatch", dispatchIds: ["dispatch-a"] }).rows[0], {
    dispatchId: "dispatch-a",
    runtimeSessionId: "runtime-a",
    attemptGroupId: "group-a",
    groupVersion: 5,
    attempt: {
      phase: "closed",
      process: "exited",
      stopProof: "proven_stopped",
      capacity: "released",
      outcome: "succeeded",
    },
    group: {
      phase: "closed",
      currentDispatchId: "dispatch-a",
      successorDispatchId: null,
      notBeforeAt: null,
    },
    policy: {
      attemptSettled: true,
      groupSettled: true,
      canRecover: true,
      capacityDisposition: "free",
    },
  });
});

test("active lifecycle cursors are returned only when another page exists", () => {
  const first = event("dispatch_admitted");
  const oneGroup = apply(emptyDispatchLifecycleProjection(), first, 1);
  assert.equal(readDispatchLifecycle(oneGroup, { by: "active", limit: 1 }).nextCursor, null);

  const second = event("dispatch_admitted", {
    eventId: "admit-second",
    repoId: "repo-b",
    attemptGroupId: "group-b",
    dispatchId: "dispatch-b",
    runtimeSessionId: "runtime-b",
    reservationId: "reservation-b",
    instanceId: "instance-b",
  });
  const twoGroups = apply(oneGroup, second, 2),
    page = readDispatchLifecycle(twoGroups, { by: "active", limit: 1 });
  assert.equal(page.rows.length, 1);
  assert.equal(page.nextCursor, page.rows[0]?.attemptGroupId);
});

test("migration imports every attempt in waiting-backoff and ruling groups with a stable key", () => {
  const attempt = (dispatchId: string, runtimeSessionId: string): DispatchLifecycleAttempt => ({
    dispatchId,
    runtimeSessionId,
    instanceId: "instance-a",
    phase: "closed",
    process: "exited",
    stopProof: "proven_stopped",
    capacity: "released",
    reservationId: `reservation-${dispatchId}`,
    outcome: "failed",
  });
  const waiting = migrateUnclosedDispatchGroup({
      lifecycleMigrationVersion: "v1",
      group: {
        repoId: "repo-a",
        attemptGroupId: "backoff-group",
        phase: "waiting_backoff",
        ownerFence: fence,
        attempts: [attempt("dispatch-old", "runtime-old"), attempt("dispatch-current", "runtime-current")],
        currentDispatchId: "dispatch-current",
        successorDispatchId: "dispatch-next",
        notBeforeAt: "2026-11-08T00:00:00.000Z",
        rulingId: null,
        fenceVerifiable: true,
      },
    }),
    ruling = migrateUnclosedDispatchGroup({
      lifecycleMigrationVersion: "v1",
      group: {
        repoId: "repo-a",
        attemptGroupId: "ruling-group",
        phase: "awaiting_ruling",
        ownerFence: fence,
        attempts: [attempt("dispatch-ruling", "runtime-ruling")],
        currentDispatchId: "dispatch-ruling",
        successorDispatchId: null,
        notBeforeAt: null,
        rulingId: "ruling-a",
        fenceVerifiable: true,
      },
    });
  assert.equal(waiting.idempotencyKey, "repo-a:backoff-group:v1");
  assert.equal(ruling.idempotencyKey, "repo-a:ruling-group:v1");
  const events = [...waiting.events, ...ruling.events];
  let online = emptyDispatchLifecycleProjection();
  events.forEach((value, index) => (online = apply(online, value, index + 1)));
  const backoffGroup = online.groups["backoff-group"],
    rulingGroup = online.groups["ruling-group"];
  assert.equal(backoffGroup?.phase, "waiting_backoff");
  assert.deepEqual(
    backoffGroup?.attempts.map(({ dispatchId }) => dispatchId),
    ["dispatch-old", "dispatch-current"],
  );
  assert.equal(backoffGroup?.successorDispatchId, "dispatch-next");
  assert.equal(rulingGroup?.phase, "awaiting_ruling");
  assert.equal(rulingGroup?.rulingId, "ruling-a");
  assert.deepEqual(reduceDispatchLifecycle(online, waiting.events[0]!, 3).projection, online);
  assert.deepEqual(rebuildDispatchLifecycle(events), online);
});

test("an unverified migration fence quarantines the group and preserves active capacity", () => {
  const activeAttempt: DispatchLifecycleAttempt = {
    dispatchId: "dispatch-unknown",
    runtimeSessionId: "runtime-unknown",
    instanceId: "instance-a",
    phase: "running",
    process: "alive",
    stopProof: "unproven",
    capacity: "held",
    reservationId: "reservation-unknown",
    outcome: null,
    taskLease: { taskId: "task-a", executionId: "execution-a", version: 8 },
    workspaceRef: "workspace-a",
  };
  const batch = migrateUnclosedDispatchGroup({
      lifecycleMigrationVersion: "v1",
      group: {
        repoId: "repo-a",
        attemptGroupId: "unknown-fence-group",
        phase: "running",
        ownerFence: fence,
        attempts: [activeAttempt],
        currentDispatchId: activeAttempt.dispatchId,
        successorDispatchId: "dispatch-next",
        notBeforeAt: "2026-11-08T00:00:00.000Z",
        rulingId: "ruling-a",
        fenceVerifiable: false,
      },
    }),
    projection = apply(emptyDispatchLifecycleProjection(), batch.events[0]!, 1);
  const quarantined = projection.groups["unknown-fence-group"];
  assert.equal(quarantined?.phase, "settling");
  assert.equal(quarantined?.ownerFenceVerified, false);
  assert.deepEqual(quarantined?.ownerFence, fence);
  assert.equal(quarantined?.successorDispatchId, "dispatch-next");
  assert.equal(quarantined?.notBeforeAt, "2026-11-08T00:00:00.000Z");
  assert.equal(quarantined?.rulingId, "ruling-a");
  assert.deepEqual(quarantined?.attempts[0]?.taskLease, activeAttempt.taskLease);
  assert.equal(quarantined?.attempts[0]?.workspaceRef, "workspace-a");
  assert.deepEqual(projection.activeReservationsByInstance["instance-a"], ["reservation-unknown"]);
  assert.throws(
    () =>
      reduceDispatchLifecycle(
        projection,
        event("ruling_resolved", {
          attemptGroupId: "unknown-fence-group",
          dispatchId: "dispatch-unknown",
          expectedGroupVersion: 1,
          eventId: "unknown-fence-resolve",
          ownerFence: fence,
          rulingId: "migration",
        }),
        2,
      ),
    { name: "DispatchLifecycleError", code: "stale_owner_fence" },
  );
  assert.throws(
    () =>
      reduceDispatchLifecycle(
        projection,
        event("process_stop_proven", {
          attemptGroupId: "unknown-fence-group",
          dispatchId: "dispatch-unknown",
          expectedGroupVersion: 1,
          eventId: "unknown-fence-stop",
          ownerFence: fence,
          proof: "proven_stopped",
        }),
        2,
      ),
    { name: "DispatchLifecycleError", code: "stale_owner_fence" },
  );
  const verified = apply(
      projection,
      event("owner_fence_verified", {
        attemptGroupId: "unknown-fence-group",
        dispatchId: "dispatch-unknown",
        expectedGroupVersion: 1,
        eventId: "fence-verified",
        ownerFence: fence,
        verification: "center",
      }),
      2,
    ),
    lost = apply(
      verified,
      event("process_lost", {
        attemptGroupId: "unknown-fence-group",
        dispatchId: "dispatch-unknown",
        expectedGroupVersion: 2,
        eventId: "process-lost",
      }),
      3,
    ),
    stopped = apply(
      lost,
      event("process_stop_proven", {
        attemptGroupId: "unknown-fence-group",
        dispatchId: "dispatch-unknown",
        expectedGroupVersion: 3,
        eventId: "stop-proven",
        proof: "proven_stopped",
      }),
      4,
    );
  assert.deepEqual(stopped.activeReservationsByInstance["instance-a"], []);
  assert.throws(
    () =>
      reduceDispatchLifecycle(
        stopped,
        event("ruling_requested", {
          attemptGroupId: "unknown-fence-group",
          dispatchId: "dispatch-unknown",
          expectedGroupVersion: 4,
          eventId: "ruling-no-lease-release",
          rulingId: "ruling-a",
        }),
        5,
      ),
    { name: "DispatchLifecycleError", code: "task_lease_release_mismatch" },
  );
  const awaiting = apply(
    stopped,
    event("ruling_requested", {
      attemptGroupId: "unknown-fence-group",
      dispatchId: "dispatch-unknown",
      expectedGroupVersion: 4,
      eventId: "ruling-with-lease-release",
      rulingId: "ruling-a",
      releasedTaskLease: activeAttempt.taskLease,
    }),
    5,
  );
  assert.equal(awaiting.groups["unknown-fence-group"]?.phase, "awaiting_ruling");
  assert.deepEqual(awaiting.activeReservationsByInstance["instance-a"], []);
  assert.deepEqual(projection.activeReservationsByInstance["instance-a"], ["reservation-unknown"]);
});

test("an unverified terminal current attempt stays settling until stop proof", () => {
  const terminalAttempt: DispatchLifecycleAttempt = {
      dispatchId: "dispatch-terminal-current",
      runtimeSessionId: "runtime-terminal-current",
      instanceId: "instance-a",
      phase: "settling",
      process: "exited",
      stopProof: "unproven",
      capacity: "held",
      reservationId: "reservation-terminal-current",
      outcome: "failed",
    },
    batch = migrateUnclosedDispatchGroup({
      lifecycleMigrationVersion: "v1",
      group: {
        repoId: "repo-a",
        attemptGroupId: "terminal-current-group",
        phase: "awaiting_ruling",
        ownerFence: null,
        attempts: [terminalAttempt],
        currentDispatchId: terminalAttempt.dispatchId,
        successorDispatchId: null,
        notBeforeAt: null,
        rulingId: "ruling-terminal",
        fenceVerifiable: false,
      },
    }),
    projection = apply(emptyDispatchLifecycleProjection(), batch.events[0]!, 1),
    group = projection.groups["terminal-current-group"];
  assert.equal(group?.phase, "settling");
  assert.equal(group?.attempts[0]?.phase, "settling");
  assert.equal(group?.attempts[0]?.stopProof, "unproven");
  assert.equal(group?.attempts[0]?.capacity, "held");
  assert.deepEqual(projection.activeReservationsByInstance["instance-a"], ["reservation-terminal-current"]);
});

test("a missing migrated fence can only be replaced by center verification", () => {
  const activeAttempt: DispatchLifecycleAttempt = {
      dispatchId: "dispatch-missing-fence",
      runtimeSessionId: "runtime-missing-fence",
      instanceId: "instance-a",
      phase: "running",
      process: "alive",
      stopProof: "unproven",
      capacity: "held",
      reservationId: "reservation-missing-fence",
      outcome: null,
    },
    imported = migrateUnclosedDispatchGroup({
      lifecycleMigrationVersion: "v1",
      group: {
        repoId: "repo-a",
        attemptGroupId: "missing-fence-group",
        phase: "running",
        ownerFence: null,
        attempts: [activeAttempt],
        currentDispatchId: activeAttempt.dispatchId,
        successorDispatchId: null,
        notBeforeAt: null,
        rulingId: null,
        fenceVerifiable: false,
      },
    }),
    projection = apply(emptyDispatchLifecycleProjection(), imported.events[0]!, 1),
    quarantined = projection.groups["missing-fence-group"];
  assert.equal(quarantined?.phase, "settling");
  assert.equal(quarantined?.ownerFence, null);
  assert.deepEqual(projection.activeReservationsByInstance["instance-a"], ["reservation-missing-fence"]);
  assert.throws(
    () =>
      reduceDispatchLifecycle(
        projection,
        event("process_lost", {
          attemptGroupId: "missing-fence-group",
          dispatchId: activeAttempt.dispatchId,
          expectedGroupVersion: 1,
          eventId: "missing-fence-process-lost",
          ownerFence: fence,
          source: "edge",
        }),
        2,
      ),
    { name: "DispatchLifecycleError", code: "stale_owner_fence" },
  );
  const verified = apply(
    projection,
    event("owner_fence_verified", {
      attemptGroupId: "missing-fence-group",
      dispatchId: activeAttempt.dispatchId,
      expectedGroupVersion: 1,
      eventId: "missing-fence-verified",
      ownerFence: fence,
      verification: "center",
    }),
    2,
  );
  assert.deepEqual(verified.groups["missing-fence-group"]?.ownerFence, fence);
  assert.equal(verified.groups["missing-fence-group"]?.ownerFenceVerified, true);
});
