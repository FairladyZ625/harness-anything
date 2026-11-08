import { stableStringify } from "../integrity/stable-hash.ts";

export const dispatchGroupPhases = [
  "starting",
  "running",
  "settling",
  "waiting_backoff",
  "awaiting_ruling",
  "closed",
] as const;
export const dispatchAttemptPhases = ["starting", "running", "settling", "closed"] as const;
export type DispatchGroupPhase = (typeof dispatchGroupPhases)[number];
export type DispatchAttemptPhase = (typeof dispatchAttemptPhases)[number];
export type DispatchLifecycleOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stopped"
  | "lost"
  | "exhausted"
  | "superseded"
  | "unknown";
export type DispatchStopProof = "unproven" | "proven_stopped" | "launch_fenced_off";
export type DispatchCapacity = "reserved" | "held" | "released";

export interface DispatchOwnerFence {
  readonly ownerId: string;
  readonly epoch: number;
}

export type DispatchLifecycleEventSource = "center" | "edge";

interface EventBase {
  readonly schema: "dispatch-lifecycle-event/v1";
  readonly source: DispatchLifecycleEventSource;
  readonly eventId: string;
  readonly repoId: string;
  readonly attemptGroupId: string;
  readonly dispatchId: string;
  readonly expectedGroupVersion: number;
  readonly ownerFence: DispatchOwnerFence | null;
}

export type DispatchLifecycleEvent =
  | (EventBase & {
      readonly type: "group_imported";
      readonly lifecycleMigrationVersion: string;
      readonly group: DispatchLifecycleGroup;
    })
  | (EventBase & {
      readonly type: "dispatch_admitted";
      readonly instanceId: string;
      readonly runtimeSessionId: string;
      readonly reservationId: string;
      readonly capacityLimit: number;
      readonly taskLease?: { readonly taskId: string; readonly executionId: string; readonly version: number } | null;
      readonly workspaceRef?: string | null;
    })
  | (EventBase & { readonly type: "owner_fence_verified"; readonly verification: "center" })
  | (EventBase & { readonly type: "process_started" })
  | (EventBase & { readonly type: "adopted_process_observed"; readonly process: "alive" | "absent" })
  | (EventBase & { readonly type: "process_exit" | "process_lost" })
  | (EventBase & { readonly type: "process_stop_proven"; readonly proof: Exclude<DispatchStopProof, "unproven"> })
  | (EventBase & {
      readonly type: "backoff_scheduled";
      readonly outcome: DispatchLifecycleOutcome;
      readonly notBeforeAt: string;
      readonly successorDispatchId: string;
    })
  | (EventBase & { readonly type: "fallback_exhausted" })
  | (EventBase & {
      readonly type: "ruling_requested";
      readonly rulingId: string;
      readonly releasedTaskLease?: { readonly taskId: string; readonly executionId: string; readonly version: number };
    })
  | (EventBase & { readonly type: "ruling_resolved"; readonly rulingId: string })
  | (EventBase & { readonly type: "cancel_requested" })
  | (EventBase & { readonly type: "settlement_committed"; readonly outcome: DispatchLifecycleOutcome });

export interface DispatchLifecycleAttempt {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly phase: DispatchAttemptPhase;
  readonly process: "unobserved" | "alive" | "exited" | "lost";
  readonly stopProof: DispatchStopProof;
  readonly capacity: DispatchCapacity;
  readonly reservationId: string;
  readonly outcome: DispatchLifecycleOutcome | null;
  readonly taskLease?: { readonly taskId: string; readonly executionId: string; readonly version: number } | null;
  readonly workspaceRef?: string | null;
}

export interface DispatchLifecycleGroup {
  readonly repoId: string;
  readonly attemptGroupId: string;
  readonly phase: DispatchGroupPhase;
  readonly ownerFence: DispatchOwnerFence | null;
  readonly ownerFenceVerified: boolean;
  readonly version: number;
  readonly currentDispatchId: string;
  readonly successorDispatchId: string | null;
  readonly notBeforeAt: string | null;
  readonly rulingId: string | null;
  readonly attempts: readonly DispatchLifecycleAttempt[];
}

export interface DispatchLifecycleProjection {
  readonly schema: "dispatch-lifecycle-projection/v1";
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly groups: Readonly<Record<string, DispatchLifecycleGroup>>;
  readonly groupByDispatchId: Readonly<Record<string, string>>;
  readonly groupBySessionId: Readonly<Record<string, string>>;
  readonly activeGroupIds: readonly string[];
  readonly acceptedEventIds: Readonly<Record<string, string>>;
  readonly activeReservationsByInstance: Readonly<Record<string, readonly string[]>>;
}

export interface DispatchLifecycleReceipt {
  readonly projection: DispatchLifecycleProjection;
  readonly accepted: boolean;
  readonly group: DispatchLifecycleGroup;
}

export type DispatchLifecycleQuery =
  | { readonly by: "dispatch"; readonly dispatchIds: readonly string[] }
  | { readonly by: "session"; readonly runtimeSessionId: string }
  | { readonly by: "group"; readonly attemptGroupId: string }
  | {
      readonly by: "active";
      readonly instanceId?: string;
      readonly limit: number;
      readonly afterGroupId?: string;
    };

export interface DispatchLifecycleView {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly attemptGroupId: string;
  /** Expected version for the next fenced event on this group. */
  readonly groupVersion: number;
  readonly attempt: Pick<DispatchLifecycleAttempt, "phase" | "process" | "stopProof" | "capacity" | "outcome">;
  readonly group: Pick<DispatchLifecycleGroup, "phase" | "currentDispatchId" | "successorDispatchId" | "notBeforeAt">;
  readonly policy: {
    readonly attemptSettled: boolean;
    readonly groupSettled: boolean;
    readonly canRecover: boolean;
    readonly capacityDisposition: "busy" | "recovering" | "free";
  };
}

export interface DispatchLifecycleRead {
  readonly status: "ready" | "pending";
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly rows: readonly DispatchLifecycleView[];
  readonly nextCursor: string | null;
}

export interface LegacyDispatchGroupForMigration {
  readonly repoId: string;
  readonly attemptGroupId: string;
  readonly phase: Exclude<DispatchGroupPhase, "closed">;
  readonly ownerFence: DispatchOwnerFence | null;
  readonly attempts: readonly DispatchLifecycleAttempt[];
  readonly currentDispatchId: string;
  readonly successorDispatchId: string | null;
  readonly notBeforeAt: string | null;
  readonly rulingId: string | null;
  readonly fenceVerifiable: boolean;
}

export interface DispatchLifecycleMigrationBatch {
  readonly idempotencyKey: string;
  readonly events: readonly DispatchLifecycleEvent[];
}

export class DispatchLifecycleError extends Error {
  readonly code:
    | "invalid_transition"
    | "stale_group_version"
    | "stale_owner_fence"
    | "duplicate_event_conflict"
    | "instance_capacity_exhausted"
    | "task_lease_release_mismatch"
    | "invalid_event";

  constructor(code: DispatchLifecycleError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "DispatchLifecycleError";
  }
}

export function emptyDispatchLifecycleProjection(): DispatchLifecycleProjection {
  return {
    schema: "dispatch-lifecycle-projection/v1",
    watermark: 0,
    sourceRevision: 0,
    groups: {},
    groupByDispatchId: {},
    groupBySessionId: {},
    activeGroupIds: [],
    acceptedEventIds: {},
    activeReservationsByInstance: {},
  };
}

export function isDispatchLifecycleEvent(value: unknown): value is DispatchLifecycleEvent {
  return validateDispatchLifecycleEvent(value).length === 0;
}

export function validateDispatchLifecycleEvent(value: unknown): readonly string[] {
  if (!value || typeof value !== "object") return ["dispatch lifecycle event is not an object"];
  const event = value as Partial<DispatchLifecycleEvent>;
  if (
    event.schema !== "dispatch-lifecycle-event/v1" ||
    typeof event.eventId !== "string" ||
    typeof event.repoId !== "string" ||
    typeof event.attemptGroupId !== "string" ||
    typeof event.dispatchId !== "string" ||
    typeof event.type !== "string"
  )
    return ["dispatch lifecycle event envelope is invalid"];
  try {
    validateEvent(event as DispatchLifecycleEvent);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Pure event reducer. Call it only from the canonical single-writer path. */
export function reduceDispatchLifecycle(
  current: DispatchLifecycleProjection,
  event: DispatchLifecycleEvent,
  acceptedRevision: number,
): DispatchLifecycleReceipt {
  if (!Number.isSafeInteger(acceptedRevision) || acceptedRevision < 0)
    throw new DispatchLifecycleError("invalid_event", "dispatch lifecycle accepted revision is invalid");
  validateEvent(event);
  const fingerprint = stableStringify(event),
    priorFingerprint = current.acceptedEventIds[event.eventId];
  if (priorFingerprint !== undefined) {
    if (priorFingerprint !== fingerprint)
      throw new DispatchLifecycleError("duplicate_event_conflict", `event ${event.eventId} changed after acceptance`);
    const prior = current.groups[event.attemptGroupId];
    if (!prior) throw new DispatchLifecycleError("invalid_event", `accepted event ${event.eventId} has no group`);
    return { projection: current, accepted: false, group: prior };
  }

  const previous = current.groups[event.attemptGroupId] ?? null;
  if (previous === null) {
    if (event.type === "group_imported") {
      if (
        event.expectedGroupVersion !== 0 ||
        event.group.repoId !== event.repoId ||
        event.group.attemptGroupId !== event.attemptGroupId ||
        event.group.currentDispatchId !== event.dispatchId ||
        !sameNullableFence(event.group.ownerFence, event.ownerFence) ||
        event.group.phase === "closed" ||
        (event.group.ownerFenceVerified && event.ownerFence === null) ||
        (!event.group.ownerFenceVerified && event.group.phase !== "settling")
      )
        throw new DispatchLifecycleError("invalid_event", "imported dispatch group identity or ownership is invalid");
      return accept(current, event, { ...event.group, version: 1 }, acceptedRevision);
    }
    if (event.type !== "dispatch_admitted" || event.expectedGroupVersion !== 0)
      throw new DispatchLifecycleError("invalid_transition", "a new dispatch group must begin with dispatch_admitted");
    if (!event.ownerFence)
      throw new DispatchLifecycleError("invalid_event", "dispatch admission requires an owner fence");
    if (activeReservationCount(current, event.instanceId) >= event.capacityLimit)
      throw new DispatchLifecycleError("instance_capacity_exhausted", `instance ${event.instanceId} has no capacity`);
    const attempt: DispatchLifecycleAttempt = {
      dispatchId: event.dispatchId,
      runtimeSessionId: event.runtimeSessionId,
      instanceId: event.instanceId,
      phase: "starting",
      process: "unobserved",
      stopProof: "unproven",
      capacity: "reserved",
      reservationId: event.reservationId,
      outcome: null,
      taskLease: event.taskLease ?? null,
      workspaceRef: event.workspaceRef ?? null,
    };
    const group: DispatchLifecycleGroup = {
      repoId: event.repoId,
      attemptGroupId: event.attemptGroupId,
      phase: "starting",
      ownerFence: event.ownerFence,
      ownerFenceVerified: true,
      version: 1,
      currentDispatchId: event.dispatchId,
      successorDispatchId: null,
      notBeforeAt: null,
      rulingId: null,
      attempts: [attempt],
    };
    return accept(current, event, group, acceptedRevision);
  }

  if (previous.repoId !== event.repoId)
    throw new DispatchLifecycleError("invalid_event", "dispatch group repository identity changed");
  const verifiesImportedFence = event.type === "owner_fence_verified",
    // A restarted owner adopts under its own, newer writer epoch; an older epoch stays fenced off.
    renewsOwnerFence =
      event.type === "adopted_process_observed" &&
      event.ownerFence !== null &&
      previous.ownerFence !== null &&
      previous.ownerFenceVerified &&
      event.ownerFence.epoch > previous.ownerFence.epoch;
  if (
    verifiesImportedFence
      ? previous.ownerFenceVerified ||
        previous.phase !== "settling" ||
        event.ownerFence === null ||
        (previous.ownerFence !== null && !sameFence(previous.ownerFence, event.ownerFence))
      : !renewsOwnerFence &&
        (event.ownerFence === null ||
          previous.ownerFence === null ||
          !sameFence(previous.ownerFence, event.ownerFence) ||
          !previous.ownerFenceVerified)
  )
    throw new DispatchLifecycleError("stale_owner_fence", "dispatch event owner fence is stale");
  if (previous.version !== event.expectedGroupVersion)
    throw new DispatchLifecycleError("stale_group_version", "dispatch group version changed before event acceptance");
  if (
    previous.currentDispatchId !== event.dispatchId &&
    !(event.type === "dispatch_admitted" && previous.successorDispatchId === event.dispatchId)
  )
    throw new DispatchLifecycleError("stale_owner_fence", "dispatch event targets a non-current attempt");

  const currentAttempt = previous.attempts.at(-1);
  if (!currentAttempt) throw new DispatchLifecycleError("invalid_event", "dispatch group has no attempts");
  let nextAttempt = currentAttempt,
    phase = previous.phase,
    successorDispatchId = previous.successorDispatchId,
    notBeforeAt = previous.notBeforeAt,
    rulingId = previous.rulingId;

  switch (event.type) {
    case "group_imported":
      invalidTransition(event, previous.phase);
      break;
    case "dispatch_admitted":
      if (previous.phase !== "waiting_backoff" || previous.successorDispatchId !== event.dispatchId)
        invalidTransition(event, previous.phase);
      if (activeReservationCount(current, event.instanceId) >= event.capacityLimit)
        throw new DispatchLifecycleError("instance_capacity_exhausted", `instance ${event.instanceId} has no capacity`);
      nextAttempt = {
        dispatchId: event.dispatchId,
        runtimeSessionId: event.runtimeSessionId,
        instanceId: event.instanceId,
        phase: "starting",
        process: "unobserved",
        stopProof: "unproven",
        capacity: "reserved",
        reservationId: event.reservationId,
        outcome: null,
        taskLease: event.taskLease ?? null,
        workspaceRef: event.workspaceRef ?? null,
      };
      phase = "starting";
      successorDispatchId = null;
      notBeforeAt = null;
      break;
    case "process_started":
      requireAttempt(currentAttempt, "starting", event);
      nextAttempt = { ...currentAttempt, phase: "running", process: "alive", capacity: "held" };
      phase = "running";
      break;
    case "adopted_process_observed":
      // Adoption reconnects observation only: a live starting attempt is confirmed running, and an
      // accepted settling attempt never returns to running.
      if (currentAttempt.phase === "closed") invalidTransition(event, previous.phase);
      if (event.process === "alive" && currentAttempt.phase === "starting") {
        nextAttempt = { ...currentAttempt, phase: "running", process: "alive", capacity: "held" };
        phase = "running";
      }
      break;
    case "owner_fence_verified":
      if (event.source !== "center" || event.verification !== "center") invalidTransition(event, previous.phase);
      break;
    case "process_exit":
    case "process_lost":
      if (currentAttempt.phase !== "starting" && currentAttempt.phase !== "running")
        invalidTransition(event, previous.phase);
      nextAttempt = {
        ...currentAttempt,
        phase: "settling",
        process: event.type === "process_exit" ? "exited" : "lost",
        stopProof: "unproven",
      };
      phase = "settling";
      break;
    case "process_stop_proven":
      requireAttempt(currentAttempt, "settling", event);
      nextAttempt = { ...currentAttempt, stopProof: event.proof, capacity: "released" };
      break;
    case "backoff_scheduled":
      requireStopped(currentAttempt, event);
      if (previous.phase !== "settling") invalidTransition(event, previous.phase);
      nextAttempt = { ...currentAttempt, phase: "closed", outcome: event.outcome };
      phase = "waiting_backoff";
      successorDispatchId = event.successorDispatchId;
      notBeforeAt = event.notBeforeAt;
      break;
    case "fallback_exhausted":
      if (previous.phase !== "waiting_backoff") invalidTransition(event, previous.phase);
      phase = "closed";
      successorDispatchId = null;
      notBeforeAt = null;
      break;
    case "ruling_requested":
      requireStopped(currentAttempt, event);
      if (previous.phase !== "settling" || currentAttempt.phase === "closed") invalidTransition(event, previous.phase);
      if (
        (currentAttempt.taskLease !== null &&
          currentAttempt.taskLease !== undefined &&
          (event.releasedTaskLease?.taskId !== currentAttempt.taskLease.taskId ||
            event.releasedTaskLease.executionId !== currentAttempt.taskLease.executionId ||
            event.releasedTaskLease.version !== currentAttempt.taskLease.version)) ||
        (currentAttempt.taskLease == null && event.releasedTaskLease !== undefined)
      )
        throw new DispatchLifecycleError(
          "task_lease_release_mismatch",
          "ruling wait requires the exact task lease release accepted for this dispatch",
        );
      nextAttempt = { ...currentAttempt, phase: "closed", outcome: currentAttempt.outcome ?? "stopped" };
      phase = "awaiting_ruling";
      rulingId = event.rulingId;
      break;
    case "ruling_resolved":
      if (previous.phase !== "awaiting_ruling" || rulingId !== event.rulingId) invalidTransition(event, previous.phase);
      phase = "closed";
      rulingId = null;
      break;
    case "cancel_requested":
      if (previous.phase === "closed" || previous.phase === "awaiting_ruling") invalidTransition(event, previous.phase);
      nextAttempt = { ...currentAttempt, phase: "settling" };
      phase = "settling";
      break;
    case "settlement_committed":
      requireStopped(currentAttempt, event);
      if (previous.phase !== "settling") invalidTransition(event, previous.phase);
      nextAttempt = { ...currentAttempt, phase: "closed", outcome: event.outcome };
      phase = "closed";
      break;
    default:
      return unhandledDispatchEvent(event);
  }

  const attempts =
    event.type === "dispatch_admitted"
      ? [...previous.attempts, nextAttempt]
      : nextAttempt === currentAttempt
        ? previous.attempts
        : [...previous.attempts.slice(0, -1), nextAttempt];
  const group: DispatchLifecycleGroup = {
    ...previous,
    phase,
    ownerFence: verifiesImportedFence || renewsOwnerFence ? event.ownerFence : previous.ownerFence,
    ownerFenceVerified: event.type === "owner_fence_verified" ? true : previous.ownerFenceVerified,
    version: previous.version + 1,
    currentDispatchId: event.type === "dispatch_admitted" ? event.dispatchId : previous.currentDispatchId,
    successorDispatchId,
    notBeforeAt,
    rulingId,
    attempts,
  };
  return accept(current, event, group, acceptedRevision);
}

export function rebuildDispatchLifecycle(events: readonly DispatchLifecycleEvent[]): DispatchLifecycleProjection {
  let projection = emptyDispatchLifecycleProjection();
  for (let index = 0; index < events.length; index += 1)
    projection = reduceDispatchLifecycle(projection, events[index]!, index + 1).projection;
  return projection;
}

/** Convert one unfinished legacy group to a replayable canonical import event. */
export function migrateUnclosedDispatchGroup(input: {
  readonly group: LegacyDispatchGroupForMigration;
  readonly lifecycleMigrationVersion: string;
}): DispatchLifecycleMigrationBatch {
  const { group, lifecycleMigrationVersion } = input;
  if (!lifecycleMigrationVersion || group.attempts.length === 0)
    throw new DispatchLifecycleError("invalid_event", "dispatch migration requires a version and at least one attempt");
  const currentAttempt = group.attempts.find((attempt) => attempt.dispatchId === group.currentDispatchId);
  if (!currentAttempt)
    throw new DispatchLifecycleError("invalid_event", "dispatch migration current attempt is missing");
  if (group.fenceVerifiable && group.ownerFence === null)
    throw new DispatchLifecycleError("invalid_event", "verified dispatch migration requires its original owner fence");
  const fence = group.ownerFence,
    ownerFenceVerified = group.fenceVerifiable,
    phase = ownerFenceVerified ? group.phase : "settling",
    imported: DispatchLifecycleGroup = {
      repoId: group.repoId,
      attemptGroupId: group.attemptGroupId,
      phase,
      ownerFence: fence,
      ownerFenceVerified,
      version: 1,
      currentDispatchId: group.currentDispatchId,
      successorDispatchId: group.successorDispatchId,
      notBeforeAt: group.notBeforeAt,
      rulingId: group.rulingId,
      attempts: group.attempts.map((attempt) => ({ ...attempt })),
    },
    key = `${group.repoId}:${group.attemptGroupId}:${lifecycleMigrationVersion}`,
    event: DispatchLifecycleEvent = {
      schema: "dispatch-lifecycle-event/v1",
      source: "center",
      eventId: `dispatch-lifecycle-migration:${key}`,
      repoId: group.repoId,
      attemptGroupId: group.attemptGroupId,
      dispatchId: currentAttempt.dispatchId,
      expectedGroupVersion: 0,
      ownerFence: fence,
      type: "group_imported",
      lifecycleMigrationVersion,
      group: imported,
    };
  return { idempotencyKey: key, events: [event] };
}

export function readDispatchLifecycle(
  projection: DispatchLifecycleProjection,
  query: DispatchLifecycleQuery,
): DispatchLifecycleRead {
  if (query.by === "dispatch" && (query.dispatchIds.length < 1 || query.dispatchIds.length > 100))
    throw new RangeError("dispatch lifecycle point read requires 1 to 100 dispatch ids");
  if (query.by === "dispatch" && query.dispatchIds.some((dispatchId) => !dispatchId))
    throw new RangeError("dispatch lifecycle point read requires non-empty dispatch ids");
  if (query.by === "session" && !query.runtimeSessionId) throw new RangeError("runtime session id is required");
  if (query.by === "group" && !query.attemptGroupId) throw new RangeError("attempt group id is required");
  if (
    query.by === "active" &&
    (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100 || query.afterGroupId === "")
  )
    throw new RangeError("dispatch lifecycle active page limit must be between 1 and 100");
  const activeGroups =
    query.by === "active"
      ? activeDispatchLifecycleGroups(projection, {
          ...(query.instanceId === undefined ? {} : { instanceId: query.instanceId }),
          limit: query.limit + 1,
          ...(query.afterGroupId === undefined ? {} : { afterGroupId: query.afterGroupId }),
        })
      : null;
  const groups =
    query.by === "group"
      ? [projection.groups[query.attemptGroupId]].filter(
          (group): group is DispatchLifecycleGroup => group !== undefined,
        )
      : query.by === "dispatch"
        ? [...new Set(query.dispatchIds.map((dispatchId) => projection.groupByDispatchId[dispatchId]))].flatMap(
            (groupId) => {
              const group = groupId === undefined ? undefined : projection.groups[groupId];
              return group ? [group] : [];
            },
          )
        : query.by === "session"
          ? (() => {
              const groupId = projection.groupBySessionId[query.runtimeSessionId],
                group = groupId === undefined ? undefined : projection.groups[groupId];
              return group ? [group] : [];
            })()
          : activeGroups!.slice(0, query.limit);
  const rows: DispatchLifecycleView[] = groups.flatMap((group) =>
    group.attempts
      .filter((attempt) =>
        query.by === "dispatch"
          ? query.dispatchIds.includes(attempt.dispatchId)
          : query.by === "session"
            ? attempt.runtimeSessionId === query.runtimeSessionId
            : query.by === "group" || attempt.dispatchId === group.currentDispatchId,
      )
      .map((attempt) => ({
        dispatchId: attempt.dispatchId,
        runtimeSessionId: attempt.runtimeSessionId,
        attemptGroupId: group.attemptGroupId,
        groupVersion: group.version,
        attempt: {
          phase: attempt.phase,
          process: attempt.process,
          stopProof: attempt.stopProof,
          capacity: attempt.capacity,
          outcome: attempt.outcome,
        },
        group: {
          phase: group.phase,
          currentDispatchId: group.currentDispatchId,
          successorDispatchId: group.successorDispatchId,
          notBeforeAt: group.notBeforeAt,
        },
        policy: {
          attemptSettled: attempt.phase === "closed",
          groupSettled: group.phase === "closed",
          canRecover: group.phase === "closed" && attempt.stopProof !== "unproven",
          capacityDisposition:
            attempt.capacity === "released"
              ? "free"
              : attempt.stopProof === "unproven" && attempt.phase === "settling"
                ? "recovering"
                : "busy",
        },
      })),
  );
  return {
    status: "ready",
    watermark: projection.watermark,
    sourceRevision: projection.sourceRevision,
    rows,
    nextCursor:
      query.by === "active" && activeGroups!.length > query.limit ? (rows.at(-1)?.attemptGroupId ?? null) : null,
  };
}

export function activeDispatchLifecycleGroups(
  projection: DispatchLifecycleProjection,
  filters: { readonly instanceId?: string; readonly limit: number; readonly afterGroupId?: string },
): readonly DispatchLifecycleGroup[] {
  if (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > 101)
    throw new RangeError("active dispatch lifecycle page limit must be from 1 to 101");
  return projection.activeGroupIds
    .flatMap((groupId) => {
      const group = projection.groups[groupId];
      return group ? [group] : [];
    })
    .filter((group) => filters.instanceId === undefined || group.attempts.at(-1)?.instanceId === filters.instanceId)
    .filter((group) => filters.afterGroupId === undefined || group.attemptGroupId > filters.afterGroupId)
    .sort((left, right) => left.attemptGroupId.localeCompare(right.attemptGroupId))
    .slice(0, filters.limit);
}

function accept(
  current: DispatchLifecycleProjection,
  event: DispatchLifecycleEvent,
  group: DispatchLifecycleGroup,
  acceptedRevision: number,
): DispatchLifecycleReceipt {
  const groups = { ...current.groups, [group.attemptGroupId]: group },
    groupByDispatchId = { ...current.groupByDispatchId },
    groupBySessionId = { ...current.groupBySessionId },
    activeGroupIds =
      group.phase === "closed"
        ? current.activeGroupIds.filter((groupId) => groupId !== group.attemptGroupId)
        : current.activeGroupIds.includes(group.attemptGroupId)
          ? current.activeGroupIds
          : [...current.activeGroupIds, group.attemptGroupId],
    acceptedEventIds = { ...current.acceptedEventIds, [event.eventId]: stableStringify(event) },
    activeReservationsByInstance = { ...current.activeReservationsByInstance };
  const priorActive =
      current.groups[group.attemptGroupId]?.attempts.filter((attempt) => attempt.capacity !== "released") ?? [],
    nextActive = group.attempts.filter((attempt) => attempt.capacity !== "released"),
    nextReservationKeys = new Set(nextActive.map(({ instanceId, reservationId }) => `${instanceId}\0${reservationId}`));
  for (const attempt of priorActive)
    if (!nextReservationKeys.has(`${attempt.instanceId}\0${attempt.reservationId}`))
      activeReservationsByInstance[attempt.instanceId] = (
        activeReservationsByInstance[attempt.instanceId] ?? []
      ).filter((reservationId) => reservationId !== attempt.reservationId);
  for (const attempt of nextActive) {
    const reservations = activeReservationsByInstance[attempt.instanceId] ?? [];
    if (!reservations.includes(attempt.reservationId))
      activeReservationsByInstance[attempt.instanceId] = [...reservations, attempt.reservationId];
  }
  for (const attempt of group.attempts) {
    groupByDispatchId[attempt.dispatchId] = group.attemptGroupId;
    groupBySessionId[attempt.runtimeSessionId] = group.attemptGroupId;
  }
  const projection: DispatchLifecycleProjection = {
    ...current,
    watermark: current.watermark + 1,
    sourceRevision: Math.max(current.sourceRevision, acceptedRevision),
    groups,
    groupByDispatchId,
    groupBySessionId,
    activeGroupIds,
    acceptedEventIds,
    activeReservationsByInstance,
  };
  return { projection, accepted: true, group };
}

function activeReservationCount(projection: DispatchLifecycleProjection, instanceId: string): number {
  return projection.activeReservationsByInstance[instanceId]?.length ?? 0;
}

function validateEvent(event: DispatchLifecycleEvent): void {
  const eventTypes = [
      "group_imported",
      "dispatch_admitted",
      "owner_fence_verified",
      "process_started",
      "adopted_process_observed",
      "process_exit",
      "process_lost",
      "process_stop_proven",
      "backoff_scheduled",
      "fallback_exhausted",
      "ruling_requested",
      "ruling_resolved",
      "cancel_requested",
      "settlement_committed",
    ] as const,
    outcomes = ["succeeded", "failed", "cancelled", "stopped", "lost", "exhausted", "superseded", "unknown"] as const;
  if (
    event.schema !== "dispatch-lifecycle-event/v1" ||
    !eventTypes.includes(event.type) ||
    (event.source !== "center" && event.source !== "edge") ||
    !event.eventId ||
    !event.repoId ||
    !event.attemptGroupId ||
    !event.dispatchId ||
    !Number.isSafeInteger(event.expectedGroupVersion) ||
    event.expectedGroupVersion < 0
  )
    throw new DispatchLifecycleError("invalid_event", "dispatch lifecycle event identity or fence is invalid");
  if (
    event.type !== "group_imported" &&
    (!event.ownerFence ||
      !event.ownerFence.ownerId ||
      !Number.isSafeInteger(event.ownerFence.epoch) ||
      event.ownerFence.epoch < 0)
  )
    throw new DispatchLifecycleError("invalid_event", "dispatch lifecycle owner fence is invalid");
  if (
    [
      "group_imported",
      "dispatch_admitted",
      "owner_fence_verified",
      "process_stop_proven",
      "backoff_scheduled",
      "fallback_exhausted",
      "ruling_requested",
      "ruling_resolved",
      "cancel_requested",
      "settlement_committed",
    ].includes(event.type) &&
    event.source !== "center"
  )
    throw new DispatchLifecycleError("invalid_event", `${event.type} must be accepted from the center writer`);
  if (
    event.type === "dispatch_admitted" &&
    (!event.instanceId ||
      !event.runtimeSessionId ||
      !event.reservationId ||
      !Number.isSafeInteger(event.capacityLimit) ||
      event.capacityLimit < 1)
  )
    throw new DispatchLifecycleError("invalid_event", "dispatch admission reservation is invalid");
  if (event.type === "group_imported" && (!event.lifecycleMigrationVersion || !validImportedGroup(event.group)))
    throw new DispatchLifecycleError("invalid_event", "dispatch group migration payload is invalid");
  if (event.type === "owner_fence_verified" && event.verification !== "center")
    throw new DispatchLifecycleError("invalid_event", "dispatch owner fence verification must come from the center");
  if (event.type === "adopted_process_observed" && event.process !== "alive" && event.process !== "absent")
    throw new DispatchLifecycleError("invalid_event", "dispatch adoption observation is invalid");
  if (event.type === "process_stop_proven" && event.proof !== "proven_stopped" && event.proof !== "launch_fenced_off")
    throw new DispatchLifecycleError("invalid_event", "dispatch stop proof is invalid");
  if (
    event.type === "backoff_scheduled" &&
    (!outcomes.includes(event.outcome) || !event.successorDispatchId || !Number.isFinite(Date.parse(event.notBeforeAt)))
  )
    throw new DispatchLifecycleError("invalid_event", "dispatch backoff schedule is invalid");
  if ((event.type === "ruling_requested" || event.type === "ruling_resolved") && !event.rulingId)
    throw new DispatchLifecycleError("invalid_event", "dispatch ruling id is required");
  if (event.type === "settlement_committed" && !outcomes.includes(event.outcome))
    throw new DispatchLifecycleError("invalid_event", "dispatch settlement outcome is invalid");
  if (
    event.type === "dispatch_admitted" &&
    ((event.taskLease !== undefined && event.taskLease !== null && !validTaskLease(event.taskLease)) ||
      (event.workspaceRef !== undefined && event.workspaceRef !== null && typeof event.workspaceRef !== "string"))
  )
    throw new DispatchLifecycleError("invalid_event", "dispatch task lease or workspace reference is invalid");
  if (
    event.type === "ruling_requested" &&
    event.releasedTaskLease !== undefined &&
    (!event.releasedTaskLease.taskId ||
      !event.releasedTaskLease.executionId ||
      !Number.isSafeInteger(event.releasedTaskLease.version) ||
      event.releasedTaskLease.version < 0)
  )
    throw new DispatchLifecycleError("invalid_event", "dispatch ruling lease release is invalid");
}

function validTaskLease(
  value: unknown,
): value is { readonly taskId: string; readonly executionId: string; readonly version: number } {
  if (typeof value !== "object" || value === null) return false;
  const lease = value as { readonly taskId?: unknown; readonly executionId?: unknown; readonly version?: unknown };
  return (
    typeof lease.taskId === "string" &&
    lease.taskId.length > 0 &&
    typeof lease.executionId === "string" &&
    lease.executionId.length > 0 &&
    Number.isSafeInteger(lease.version) &&
    (lease.version as number) >= 0
  );
}

function validImportedGroup(value: unknown): value is DispatchLifecycleGroup {
  if (typeof value !== "object" || value === null) return false;
  const group = value as Partial<DispatchLifecycleGroup>,
    validFence = (fence: unknown): fence is DispatchOwnerFence | null =>
      fence === null ||
      (typeof fence === "object" &&
        fence !== null &&
        typeof (fence as DispatchOwnerFence).ownerId === "string" &&
        Boolean((fence as DispatchOwnerFence).ownerId) &&
        Number.isSafeInteger((fence as DispatchOwnerFence).epoch) &&
        (fence as DispatchOwnerFence).epoch >= 0),
    validAttempt = (attempt: unknown): attempt is DispatchLifecycleAttempt => {
      if (typeof attempt !== "object" || attempt === null) return false;
      const row = attempt as Partial<DispatchLifecycleAttempt>;
      return (
        typeof row.dispatchId === "string" &&
        Boolean(row.dispatchId) &&
        typeof row.runtimeSessionId === "string" &&
        Boolean(row.runtimeSessionId) &&
        typeof row.instanceId === "string" &&
        Boolean(row.instanceId) &&
        ["starting", "running", "settling", "closed"].includes(row.phase as DispatchAttemptPhase) &&
        ["unobserved", "alive", "exited", "lost"].includes(row.process as DispatchLifecycleAttempt["process"]) &&
        ["unproven", "proven_stopped", "launch_fenced_off"].includes(row.stopProof as DispatchStopProof) &&
        ["reserved", "held", "released"].includes(row.capacity as DispatchCapacity) &&
        typeof row.reservationId === "string" &&
        Boolean(row.reservationId) &&
        (row.outcome === null ||
          ["succeeded", "failed", "cancelled", "stopped", "lost", "exhausted", "superseded", "unknown"].includes(
            row.outcome as DispatchLifecycleOutcome,
          )) &&
        (row.taskLease === undefined || row.taskLease === null || validTaskLease(row.taskLease)) &&
        (row.workspaceRef === undefined || row.workspaceRef === null || typeof row.workspaceRef === "string")
      );
    };
  return (
    typeof group.repoId === "string" &&
    Boolean(group.repoId) &&
    typeof group.attemptGroupId === "string" &&
    Boolean(group.attemptGroupId) &&
    ["starting", "running", "settling", "waiting_backoff", "awaiting_ruling", "closed"].includes(
      group.phase as DispatchGroupPhase,
    ) &&
    validFence(group.ownerFence) &&
    typeof group.ownerFenceVerified === "boolean" &&
    Number.isSafeInteger(group.version) &&
    typeof group.currentDispatchId === "string" &&
    Boolean(group.currentDispatchId) &&
    (group.successorDispatchId === null || typeof group.successorDispatchId === "string") &&
    (group.notBeforeAt === null || typeof group.notBeforeAt === "string") &&
    (group.rulingId === null || typeof group.rulingId === "string") &&
    Array.isArray(group.attempts) &&
    group.attempts.length > 0 &&
    group.attempts.every(validAttempt) &&
    group.attempts.at(-1)?.dispatchId === group.currentDispatchId &&
    !(group.ownerFenceVerified && group.ownerFence === null) &&
    (group.ownerFenceVerified || group.phase === "settling")
  );
}

function sameFence(left: DispatchOwnerFence, right: DispatchOwnerFence): boolean {
  return left.ownerId === right.ownerId && left.epoch === right.epoch;
}

function sameNullableFence(left: DispatchOwnerFence | null, right: DispatchOwnerFence | null): boolean {
  return left === null || right === null ? left === right : sameFence(left, right);
}

function requireAttempt(
  attempt: DispatchLifecycleAttempt,
  phase: DispatchAttemptPhase,
  event: DispatchLifecycleEvent,
): void {
  if (attempt.phase !== phase) invalidTransition(event, attempt.phase);
}

function requireStopped(attempt: DispatchLifecycleAttempt, event: DispatchLifecycleEvent): void {
  if (attempt.phase !== "settling" || attempt.stopProof === "unproven" || attempt.capacity !== "released")
    invalidTransition(event, "stop_unproven");
}

function invalidTransition(event: DispatchLifecycleEvent, phase: string): never {
  throw new DispatchLifecycleError("invalid_transition", `${event.type} cannot follow ${phase}`);
}

function unhandledDispatchEvent(value: never): never {
  throw new Error(`Unhandled dispatch lifecycle event: ${stableStringify(value)}`);
}
