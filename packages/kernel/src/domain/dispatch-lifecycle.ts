/**
 * Dispatch lifecycle aggregate (dec_AEB05951C69E47FCE53E53C341 CH1/CH2, design F1).
 *
 * State is a pure fold over events the center writer already accepts: the runtime dispatch and
 * session events, plus the task events that move the task lease and register a delivery. No
 * dispatch lifecycle event family exists beside them: historical shapes are interpreted here once,
 * and every projection (online apply, cold rebuild, edge replica) runs this same reducer. Business
 * judgments about a dispatch (does it hold its instance, is it settled, may it admit a successor,
 * may its ruling be resolved) are defined in this module only and read through
 * `readDispatchLifecycle`.
 *
 * Authority carried by every attempt:
 * - owner fence: the owner the center bound at admission (`local` or `node:<id>`) and the admission
 *   revision as fence token; events from another source are refused, and a launch generation below
 *   the observed one is a stale epoch. A source the center cannot bind to an owner (an imported or
 *   direct write) is `verified: false`: the attempt is admitted as `settling`, keeps its capacity
 *   reservation and task lease, cannot be advanced by any event, and is never recoverable.
 * - capacity reservation: the provider slot on the instance, released only by an observed stop.
 * - task binding: the task lease version the attempt runs under; a pending ruling becomes
 *   `awaiting_ruling` only after the stop is proven and that lease has been released.
 */
import type { AgentRuntimeEventV1, RuntimeSession } from "./agent-runtime.ts";
import type { TaskEventV1 } from "./task-lifecycle-event.ts";
import { submissionDigest } from "./submission-digest.ts";
import type { WriteSource } from "./write-source.ts";

export const dispatchGroupPhases = [
  "starting",
  "running",
  "settling",
  "waiting_backoff",
  "awaiting_ruling",
  "closed",
] as const;
export const dispatchAttemptPhases = ["starting", "running", "settling", "closed"] as const;
export const dispatchCapacityDispositions = ["busy", "recovering", "free"] as const;
/** The attempt's provider slot: reserved at admission, held while the process may run, released by a proven stop. */
export const dispatchReservationStates = ["reserved", "held", "released"] as const;
export const dispatchStopProofs = ["unproven", "proven_stopped"] as const;
export const dispatchDeliveryStatuses = ["unregistered", "registered"] as const;
export type DispatchGroupPhase = (typeof dispatchGroupPhases)[number];
export type DispatchAttemptPhase = (typeof dispatchAttemptPhases)[number];
export type DispatchCapacityDisposition = (typeof dispatchCapacityDispositions)[number];
export type DispatchReservationState = (typeof dispatchReservationStates)[number];
export type DispatchStopProof = (typeof dispatchStopProofs)[number];
/** What the owner last reported about the provider process; `unknown` means it could not observe it. */
export type DispatchProcessObservation = "unobserved" | "alive" | "unknown" | "exited";
export type DispatchAttemptOutcome = NonNullable<RuntimeSession["outcome"]>;

/** The runtime event types this aggregate folds. */
export const dispatchLifecycleEventTypes = [
  "runtime_dispatch_requested",
  "runtime_session_started",
  "runtime_session_liveness_changed",
  "runtime_session_cancelled",
  "runtime_session_exited",
  "runtime_session_outcome_observed",
] as const satisfies readonly AgentRuntimeEventV1["type"][];
/** The task event types that move a task lease or register a delivery (mirrors the task replay's `lease`). */
export const dispatchLifecycleTaskEventTypes = [
  "execution_started",
  "lease_renewed",
  "execution_submitted",
  "submission_returned",
  "task_completion_generation_retired",
  "review_recorded",
  "lease_released",
  "task_completed",
] as const satisfies readonly TaskEventV1["type"][];
export type DispatchLifecycleEventType = (typeof dispatchLifecycleEventTypes)[number];
export type DispatchLifecycleEvent = Extract<AgentRuntimeEventV1, { readonly type: DispatchLifecycleEventType }>;
export type DispatchLifecycleTaskEvent = Extract<
  TaskEventV1,
  { readonly type: (typeof dispatchLifecycleTaskEventTypes)[number] }
>;
export type DispatchLifecycleInput = DispatchLifecycleEvent | DispatchLifecycleTaskEvent;

export interface DispatchOwnerFence {
  /** `local`, `node:<id>`, or `unverified:<source>` for a source the center cannot bind to an owner. */
  readonly owner: string;
  readonly verified: boolean;
  /** Center revision that accepted the admission; it identifies this owner's tenure of the attempt. */
  readonly token: number;
  /** Launch generation of the observed provider launch; a lower generation is a stale epoch. */
  readonly epoch: number | null;
}

export interface DispatchCapacityReservation {
  readonly reservationId: string;
  readonly instanceId: string;
  /** The capacity owner: the same key as the owner fence. */
  readonly owner: string;
}

/** The task lease a launcher holds while its task attempt runs. */
export interface DispatchTaskLease {
  readonly executionId: string;
  readonly version: number;
}

export interface DispatchAttemptTask {
  readonly taskId: string;
  readonly executionId: string | null;
  /** A reviewer holds no task lease; it delivers a review of `reviewTargetDigest`. */
  readonly role: "implementer" | "reviewer";
  /** Lease version this attempt runs under; null when no lease of its execution was held. */
  readonly leaseVersion: number | null;
  readonly leaseReleased: boolean;
  readonly reviewTargetDigest: string | null;
}

export interface DispatchLifecycleAttempt {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly fence: DispatchOwnerFence;
  readonly reservation: DispatchCapacityReservation;
  readonly task: DispatchAttemptTask | null;
  /** The dispatch working directory as admitted; the group workspace a successor inherits. */
  readonly workspaceRef: string | null;
  readonly phase: DispatchAttemptPhase;
  readonly process: DispatchProcessObservation;
  /** Only a proven stop releases the provider slot. */
  readonly stopProof: DispatchStopProof;
  readonly outcome: DispatchAttemptOutcome | null;
  readonly admittedRevision: number;
  /** Event ids this attempt accepted: a redelivered event is accepted once. */
  readonly eventIds: readonly string[];
}

export interface DispatchGroupSuccessor {
  /**
   * A successor attempt may join: the group waits for a scheduled fallback, or its last attempt
   * was closed by a historical publisher that predates attempt classification (no `attempt`
   * field), whose fallback successors joined the same group without a `scheduled` marker.
   */
  readonly admissible: boolean;
  /** Earliest time the scheduled successor may launch, when the fallback named one. */
  readonly dueAt: string | null;
}

export interface DispatchGroupRuling {
  readonly dispatchId: string;
  readonly status: "awaiting";
}

export interface DispatchGroupDelivery {
  readonly status: (typeof dispatchDeliveryStatuses)[number];
  /** `execution:<id>` for a submitted implementation, `review:<id>` for a recorded review. */
  readonly targetRef: string | null;
  readonly targetDigest: string | null;
  readonly registeredRevision: number | null;
}

export interface DispatchLifecycleGroup {
  readonly attemptGroupId: string;
  readonly phase: DispatchGroupPhase;
  readonly currentDispatchId: string;
  readonly attempts: readonly DispatchLifecycleAttempt[];
  readonly successor: DispatchGroupSuccessor;
  readonly ruling: DispatchGroupRuling | null;
  readonly delivery: DispatchGroupDelivery;
  /** Revision of the last event this group accepted; replays at or below it are no-ops. */
  readonly revision: number;
}

export type DispatchLifecycleRejection =
  | "dispatch_group_busy"
  | "dispatch_attempt_closed"
  | "dispatch_attempt_superseded"
  | "dispatch_transition_illegal"
  | "dispatch_owner_fence_mismatch"
  | "dispatch_owner_unverified"
  | "dispatch_epoch_stale";

export type DispatchLifecycleStep =
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly code: DispatchLifecycleRejection; readonly reason: string }
  | { readonly kind: "applied"; readonly group: DispatchLifecycleGroup };

/** Which aggregates an input addresses; storage resolves it before calling the reducer. */
export type DispatchLifecycleAddress =
  | { readonly by: "group"; readonly attemptGroupId: string }
  | { readonly by: "session"; readonly runtimeSessionId: string }
  | { readonly by: "execution"; readonly executionIds: readonly string[] };

/** Projection state as of the input's revision; storage keeps it with the lifecycle tables. */
export interface DispatchLifecycleContext {
  /** Lease held on the input's task before the input (null when none). */
  readonly taskLease: DispatchTaskLease | null;
}

const noContext: DispatchLifecycleContext = { taskLease: null };

export function isDispatchLifecycleInput(event: {
  readonly schema: string;
  readonly type: string;
}): event is DispatchLifecycleInput {
  if (event.schema === "agent-runtime-event/v1")
    return (dispatchLifecycleEventTypes as readonly string[]).includes(event.type);
  return (
    event.schema === "task-event/v1" && (dispatchLifecycleTaskEventTypes as readonly string[]).includes(event.type)
  );
}

function isTaskInput(input: DispatchLifecycleInput): input is DispatchLifecycleTaskEvent {
  return input.schema === "task-event/v1";
}

/** The task whose lease an input reads (admission) or moves (task events). */
export function dispatchLifecycleTaskId(input: DispatchLifecycleInput): string | null {
  if (isTaskInput(input)) return input.taskId;
  return input.type === "runtime_dispatch_requested" ? (input.payload.taskId ?? null) : null;
}

/** The task lease after a task input; `undefined` leaves it unchanged. Mirrors the task replay. */
export function taskLeaseAfter(input: DispatchLifecycleInput): DispatchTaskLease | null | undefined {
  if (!isTaskInput(input)) return undefined;
  if (input.type === "execution_started" || input.type === "lease_renewed")
    return { executionId: input.payload.execution.executionId, version: input.payload.lease.version };
  return null;
}

export function dispatchLifecycleAddress(
  input: DispatchLifecycleInput,
  context: DispatchLifecycleContext = noContext,
): DispatchLifecycleAddress | null {
  if (isTaskInput(input)) {
    const ids = new Set<string>();
    const lease = taskLeaseAfter(input);
    if (lease) ids.add(lease.executionId);
    if (lease === null && context.taskLease) ids.add(context.taskLease.executionId);
    if (input.type === "execution_submitted" || input.type === "review_recorded")
      ids.add(input.payload.execution.executionId);
    return ids.size === 0 ? null : { by: "execution", executionIds: [...ids] };
  }
  if (input.type === "runtime_dispatch_requested")
    return { by: "group", attemptGroupId: input.payload.attemptGroupId ?? input.payload.dispatchId };
  return { by: "session", runtimeSessionId: input.payload.runtimeSessionId };
}

/** The owner a source binds: the center launcher, a fleet node, or an owner the center cannot verify. */
export function dispatchOwner(source: WriteSource): { readonly owner: string; readonly verified: boolean } {
  if (source === "local") return { owner: "local", verified: true };
  if (typeof source === "object" && source.kind === "node") return { owner: `node:${source.nodeId}`, verified: true };
  return { owner: `unverified:${typeof source === "string" ? source : source.kind}`, verified: false };
}

/** The owner key a launcher on `nodeId` (undefined = center-local) uses for its own dispatches. */
export function dispatchOwnerForNode(nodeId: string | undefined): string {
  return nodeId === undefined ? "local" : `node:${nodeId}`;
}

const ignored = { kind: "ignored" } as const;
const reject = (code: DispatchLifecycleRejection, reason: string): DispatchLifecycleStep => ({
  kind: "rejected",
  code,
  reason,
});

/**
 * Fold one accepted event into its group. `group` is the aggregate the event's address resolves
 * to (null when none exists); `context` is the projection state as of the event. Session events
 * for a session no dispatch admitted (historical undispatched sessions) are ignored.
 */
export function reduceDispatchLifecycle(
  group: DispatchLifecycleGroup | null,
  input: DispatchLifecycleInput,
  context: DispatchLifecycleContext = noContext,
): DispatchLifecycleStep {
  const revision = input.workspaceRevision;
  if (group !== null && revision <= group.revision) return ignored;
  if (isTaskInput(input)) return group === null ? ignored : reduceTaskInput(group, input, context);
  if (input.type === "runtime_dispatch_requested") return admit(group, input, revision, context);
  if (group === null) return ignored;
  const attempt = group.attempts.find(({ runtimeSessionId }) => runtimeSessionId === input.payload.runtimeSessionId);
  if (!attempt || attempt.eventIds.includes(input.eventId)) return ignored;
  const source = dispatchOwner(input.source);
  if (!attempt.fence.verified)
    return reject(
      "dispatch_owner_unverified",
      `Dispatch ${attempt.dispatchId} has no verified owner; ${input.type} cannot advance it.`,
    );
  if (source.owner !== attempt.fence.owner)
    return reject(
      "dispatch_owner_fence_mismatch",
      `Dispatch ${attempt.dispatchId} is owned by ${attempt.fence.owner}; ${source.owner} cannot publish ${input.type}.`,
    );
  if (attempt.phase === "closed")
    return reject(
      "dispatch_attempt_closed",
      `Dispatch ${attempt.dispatchId} is closed; a late ${input.type} cannot reopen it.`,
    );
  if (attempt.dispatchId !== group.currentDispatchId)
    return reject(
      "dispatch_attempt_superseded",
      `Dispatch ${attempt.dispatchId} is no longer the current attempt of group ${group.attemptGroupId}.`,
    );
  if (
    input.type === "runtime_session_started" &&
    attempt.fence.epoch !== null &&
    input.payload.launchGeneration < attempt.fence.epoch
  )
    return reject(
      "dispatch_epoch_stale",
      `Launch generation ${input.payload.launchGeneration} of dispatch ${attempt.dispatchId} predates ${attempt.fence.epoch}.`,
    );
  const advanced = advanceAttempt(attempt, input);
  if (advanced === null)
    return reject(
      "dispatch_transition_illegal",
      `${input.type} is not legal while dispatch ${attempt.dispatchId} is ${attempt.phase}.`,
    );
  const next = { ...advanced, eventIds: [...attempt.eventIds, input.eventId] },
    attempts = group.attempts.map((entry) => (entry === attempt ? next : entry)),
    closedBy = input.type === "runtime_session_outcome_observed" ? input.payload : null,
    ruling =
      closedBy?.attempt?.classification === "awaiting_ruling"
        ? ({ dispatchId: attempt.dispatchId, status: "awaiting" } as const)
        : group.ruling,
    scheduled = closedBy?.attempt?.fallbackState === "scheduled",
    successor: DispatchGroupSuccessor = {
      admissible: scheduled || (closedBy !== null && closedBy.attempt === undefined),
      dueAt: scheduled ? (closedBy?.attempt?.resetAt ?? null) : null,
    },
    settled = { ...group, attempts, ruling, successor, revision };
  return { kind: "applied", group: { ...settled, phase: groupPhase(settled, next, scheduled) } };
}

function admit(
  group: DispatchLifecycleGroup | null,
  event: Extract<DispatchLifecycleEvent, { readonly type: "runtime_dispatch_requested" }>,
  revision: number,
  context: DispatchLifecycleContext,
): DispatchLifecycleStep {
  const payload = event.payload,
    owner = dispatchOwner(event.source),
    role = payload.role === "reviewer" ? "reviewer" : "implementer",
    executionId = payload.executionId ?? null,
    lease = context.taskLease,
    attempt: DispatchLifecycleAttempt = {
      dispatchId: payload.dispatchId,
      runtimeSessionId: payload.runtimeSessionId,
      instanceId: payload.instanceId,
      fence: { owner: owner.owner, verified: owner.verified, token: revision, epoch: null },
      reservation: {
        reservationId: `${payload.instanceId}/${payload.dispatchId}`,
        instanceId: payload.instanceId,
        owner: owner.owner,
      },
      task:
        payload.taskId === undefined
          ? null
          : {
              taskId: payload.taskId,
              executionId,
              role,
              leaseVersion:
                role === "implementer" && lease !== null && lease.executionId === executionId ? lease.version : null,
              leaseReleased: false,
              reviewTargetDigest: payload.reviewTarget?.digest ?? null,
            },
      workspaceRef: payload.cwd ?? null,
      // A source the center cannot bind to an owner is imported as settling: nothing may run it.
      phase: owner.verified ? "starting" : "settling",
      process: "unobserved",
      stopProof: "unproven",
      outcome: null,
      admittedRevision: revision,
      eventIds: [event.eventId],
    };
  if (group === null)
    return {
      kind: "applied",
      group: {
        attemptGroupId: payload.attemptGroupId ?? payload.dispatchId,
        phase: attempt.phase,
        currentDispatchId: payload.dispatchId,
        attempts: [attempt],
        successor: { admissible: false, dueAt: null },
        ruling: null,
        delivery: { status: "unregistered", targetRef: null, targetDigest: null, registeredRevision: null },
        revision,
      },
    };
  if (group.attempts.some(({ eventIds }) => eventIds.includes(event.eventId))) return ignored;
  const refusal = dispatchSuccessorRefusal(
    {
      groupPhase: group.phase,
      successorAdmissible: group.successor.admissible,
      owner: currentDispatchAttempt(group).fence.owner,
    },
    owner.owner,
  );
  if (refusal) return reject(refusal.code, `Group ${group.attemptGroupId}: ${refusal.message}`);
  return {
    kind: "applied",
    group: {
      ...group,
      phase: attempt.phase,
      currentDispatchId: payload.dispatchId,
      attempts: [...group.attempts, attempt],
      successor: { admissible: false, dueAt: null },
      revision,
    },
  };
}

/**
 * The one successor judgment, shared by the reducer and the center writer: only a group waiting
 * for its scheduled fallback admits another attempt, and only from the owner that holds its fence.
 */
export function dispatchSuccessorRefusal(
  group: { readonly groupPhase: DispatchGroupPhase; readonly successorAdmissible: boolean; readonly owner: string },
  owner: string,
): { readonly code: "dispatch_group_busy" | "dispatch_owner_fence_mismatch"; readonly message: string } | null {
  if (!group.successorAdmissible)
    return {
      code: "dispatch_group_busy",
      message: `the group is ${group.groupPhase}; only a waiting fallback group admits a successor.`,
    };
  if (group.owner !== owner)
    return {
      code: "dispatch_owner_fence_mismatch",
      message: `the group is fenced to ${group.owner}; ${owner} cannot admit its successor.`,
    };
  return null;
}

function reduceTaskInput(
  group: DispatchLifecycleGroup,
  input: DispatchLifecycleTaskEvent,
  context: DispatchLifecycleContext,
): DispatchLifecycleStep {
  const attempt = currentDispatchAttempt(group),
    task = attempt.task;
  if (task === null || task.executionId === null) return ignored;
  const lease = taskLeaseAfter(input);
  let nextTask = task,
    delivery = group.delivery;
  if (task.role === "implementer") {
    if (lease && lease.executionId === task.executionId)
      nextTask = { ...task, leaseVersion: lease.version, leaseReleased: false };
    else if (lease === null && context.taskLease?.executionId === task.executionId && task.leaseVersion !== null)
      nextTask = { ...task, leaseReleased: true };
    if (
      input.type === "execution_submitted" &&
      input.payload.execution.executionId === task.executionId &&
      input.payload.execution.submission
    )
      delivery = registered(
        `execution:${task.executionId}`,
        submissionDigest(input.payload.execution.submission),
        input,
      );
  } else if (
    input.type === "review_recorded" &&
    input.payload.review.executionId === task.executionId &&
    input.payload.review.submissionDigest === task.reviewTargetDigest
  )
    delivery = registered(`review:${input.payload.review.reviewId}`, input.payload.review.submissionDigest, input);
  if (nextTask === task && delivery === group.delivery) return ignored;
  const next = { ...attempt, task: nextTask },
    settled = {
      ...group,
      attempts: group.attempts.map((entry) => (entry === attempt ? next : entry)),
      delivery,
      revision: input.workspaceRevision,
    };
  return {
    kind: "applied",
    group: { ...settled, phase: group.phase === "settling" ? groupPhase(settled, next, false) : group.phase },
  };
}

function registered(targetRef: string, targetDigest: string, input: DispatchLifecycleTaskEvent): DispatchGroupDelivery {
  return { status: "registered", targetRef, targetDigest, registeredRevision: input.workspaceRevision };
}

function advanceAttempt(
  attempt: DispatchLifecycleAttempt,
  event: DispatchLifecycleEvent,
): DispatchLifecycleAttempt | null {
  switch (event.type) {
    case "runtime_session_started":
      if (attempt.phase !== "starting" && attempt.phase !== "running") return null;
      return {
        ...attempt,
        phase: "running",
        process: attempt.process === "unknown" ? "unknown" : "alive",
        fence: { ...attempt.fence, epoch: event.payload.launchGeneration },
      };
    case "runtime_session_liveness_changed":
      if (attempt.process === "exited") return attempt;
      return { ...attempt, process: event.payload.liveness === "live" ? "alive" : "unknown" };
    case "runtime_session_cancelled":
      // A cancel request does not prove the provider stopped; the slot stays held.
      return { ...attempt, phase: "settling" };
    case "runtime_session_exited":
      return { ...attempt, phase: "settling", process: "exited", stopProof: "proven_stopped" };
    case "runtime_session_outcome_observed":
      // Historical owners publish the outcome only after their settlement finished with the process.
      return { ...attempt, phase: "closed", stopProof: "proven_stopped", outcome: event.payload.outcome };
    default:
      return null;
  }
}

/** A pending ruling is resolvable only once the verified owner proved the stop and released the lease. */
function rulingReady(attempt: DispatchLifecycleAttempt): boolean {
  const task = attempt.task;
  return (
    attempt.fence.verified &&
    attempt.stopProof === "proven_stopped" &&
    (task === null || task.role === "reviewer" || task.leaseVersion === null || task.leaseReleased)
  );
}

function groupPhase(
  group: Pick<DispatchLifecycleGroup, "ruling">,
  attempt: DispatchLifecycleAttempt,
  scheduled: boolean,
): DispatchGroupPhase {
  if (attempt.phase !== "closed") return attempt.phase;
  if (scheduled) return "waiting_backoff";
  if (group.ruling?.dispatchId === attempt.dispatchId) return rulingReady(attempt) ? "awaiting_ruling" : "settling";
  return "closed";
}

export function currentDispatchAttempt(group: DispatchLifecycleGroup): DispatchLifecycleAttempt {
  return group.attempts.find(({ dispatchId }) => dispatchId === group.currentDispatchId)!;
}

function reservationState(attempt: DispatchLifecycleAttempt): DispatchReservationState {
  if (attempt.phase === "closed" || attempt.stopProof === "proven_stopped") return "released";
  return attempt.phase === "starting" ? "reserved" : "held";
}

/** The one capacity judgment: a provider slot is free once the owner proved the process stopped. */
export function dispatchCapacityDisposition(attempt: DispatchLifecycleAttempt): DispatchCapacityDisposition {
  if (reservationState(attempt) === "released") return "free";
  return !attempt.fence.verified || attempt.process === "unknown" ? "recovering" : "busy";
}

export interface DispatchAdmissionBlocker {
  readonly code: "runtime_recovery_pending" | "dispatch_owner_unverified";
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly message: string;
}

/**
 * Admission on one instance is refused while an attempt there holds its slot unresolved: this
 * owner cannot observe the process, or nobody verified the owner at all (that attempt fails closed
 * for every launcher). Running attempts and other verified owners' attempts never block.
 */
export function dispatchAdmissionBlocker(
  views: readonly DispatchLifecycleView[],
  input: { readonly instanceId: string; readonly owner: string },
): DispatchAdmissionBlocker | null {
  for (const view of views) {
    const attempt = view.attempt;
    if (attempt.instanceId !== input.instanceId || view.policy.capacityDisposition !== "recovering") continue;
    if (attempt.fence.verified && attempt.fence.owner !== input.owner) continue;
    return {
      code: view.policy.blockerCode ?? "runtime_recovery_pending",
      dispatchId: attempt.dispatchId,
      runtimeSessionId: attempt.runtimeSessionId,
      message: attempt.fence.verified
        ? `Runtime ${attempt.runtimeSessionId} has unresolved capacity: its owner cannot observe the provider process.`
        : `Runtime ${attempt.runtimeSessionId} holds capacity for an owner the center cannot verify.`,
    };
  }
  return null;
}

/**
 * The center writer's admission judgment for one `runtime_dispatch_requested`: the group must
 * admit a successor (when it exists) and the instance must have no unresolved attempt blocking
 * this owner. Run inside the single writer, it is atomic with the append.
 */
export function dispatchAdmissionRefusal(input: {
  readonly group: DispatchLifecycleView | null;
  readonly instance: readonly DispatchLifecycleView[];
  readonly instanceId: string;
  readonly owner: string;
}): { readonly code: string; readonly message: string } | null {
  if (input.group !== null) {
    const refusal = dispatchSuccessorRefusal(
      {
        groupPhase: input.group.groupPhase,
        successorAdmissible: input.group.policy.successorAdmissible,
        owner: input.group.attempt.fence.owner,
      },
      input.owner,
    );
    if (refusal) return { code: refusal.code, message: `Group ${input.group.attemptGroupId}: ${refusal.message}` };
  }
  return dispatchAdmissionBlocker(input.instance, { instanceId: input.instanceId, owner: input.owner });
}

export type DispatchLifecycleQuery =
  | { readonly by: "dispatch"; readonly dispatchIds: readonly string[] }
  | { readonly by: "session"; readonly runtimeSessionId: string }
  | { readonly by: "group"; readonly attemptGroupId: string }
  | { readonly by: "active"; readonly instanceId?: string; readonly cursor?: string; readonly limit: number };

export interface DispatchLifecycleView {
  readonly attemptGroupId: string;
  readonly groupPhase: DispatchGroupPhase;
  readonly attempt: DispatchLifecycleAttempt;
  readonly successor: DispatchGroupSuccessor;
  readonly ruling: DispatchGroupRuling | null;
  readonly delivery: DispatchGroupDelivery;
  readonly revision: number;
  readonly policy: {
    readonly attemptSettled: boolean;
    readonly groupSettled: boolean;
    readonly capacity: DispatchReservationState;
    readonly capacityDisposition: DispatchCapacityDisposition;
    readonly successorAdmissible: boolean;
    readonly canResolveRuling: boolean;
    readonly canRecover: boolean;
    readonly blockerCode: DispatchAdmissionBlocker["code"] | null;
  };
}

export type DispatchLifecycleRead =
  | { readonly status: "pending"; readonly watermark: number; readonly sourceRevision: number }
  | {
      readonly status: "ready";
      readonly watermark: number;
      readonly sourceRevision: number;
      readonly rows: readonly DispatchLifecycleView[];
      readonly nextCursor: string | null;
    };

/** Point queries return the addressed attempt; group and active queries return the current one. */
export function dispatchLifecycleView(group: DispatchLifecycleGroup, dispatchId?: string): DispatchLifecycleView {
  const attempt =
      (dispatchId === undefined ? undefined : group.attempts.find((entry) => entry.dispatchId === dispatchId)) ??
      currentDispatchAttempt(group),
    capacityDisposition = dispatchCapacityDisposition(attempt);
  return {
    attemptGroupId: group.attemptGroupId,
    groupPhase: group.phase,
    attempt,
    successor: group.successor,
    ruling: group.ruling,
    delivery: group.delivery,
    revision: group.revision,
    policy: {
      attemptSettled: attempt.phase === "closed",
      groupSettled: group.phase === "closed",
      capacity: reservationState(attempt),
      capacityDisposition,
      successorAdmissible: group.successor.admissible,
      canResolveRuling: group.phase === "awaiting_ruling" && group.ruling !== null,
      canRecover:
        group.phase === "closed" &&
        group.attempts.every(({ fence, stopProof }) => fence.verified && stopProof === "proven_stopped"),
      blockerCode:
        capacityDisposition !== "recovering"
          ? null
          : attempt.fence.verified
            ? "runtime_recovery_pending"
            : "dispatch_owner_unverified",
    },
  };
}

/** Every group that is not closed belongs to the active index; storage pages it by group id. */
export function dispatchGroupIsActive(group: DispatchLifecycleGroup): boolean {
  return group.phase !== "closed";
}

/** Bump when the folded group shape changes: stored lifecycle state of another version is refolded. */
export const DISPATCH_LIFECYCLE_MODEL_VERSION = 2;

export const DISPATCH_LIFECYCLE_PAGE_LIMIT = 100;
