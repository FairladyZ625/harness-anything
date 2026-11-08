/**
 * Dispatch lifecycle aggregate (dec_AEB05951C69E47FCE53E53C341 CH1/CH2).
 *
 * State is a pure fold over the runtime events the center writer already accepts. No dispatch
 * lifecycle event family exists beside them: historical shapes are interpreted here once, and
 * every projection (online apply, cold rebuild, edge replica) runs this same reducer. Business
 * judgments about a dispatch (does it hold its instance, is it settled, does it block admission)
 * are defined in this module only and read through `readDispatchLifecycle`.
 */
import type { AgentRuntimeEventV1, RuntimeSession } from "./agent-runtime.ts";
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
export type DispatchGroupPhase = (typeof dispatchGroupPhases)[number];
export type DispatchAttemptPhase = (typeof dispatchAttemptPhases)[number];
export type DispatchCapacityDisposition = (typeof dispatchCapacityDispositions)[number];
/** What the owner last reported about the provider process; `unknown` means it could not observe it. */
export type DispatchProcessObservation = "unobserved" | "alive" | "unknown" | "exited";
export type DispatchAttemptOutcome = NonNullable<RuntimeSession["outcome"]>;

/** The runtime event types this aggregate folds; every other runtime event leaves it unchanged. */
export const dispatchLifecycleEventTypes = [
  "runtime_dispatch_requested",
  "runtime_session_started",
  "runtime_session_liveness_changed",
  "runtime_session_cancelled",
  "runtime_session_exited",
  "runtime_session_outcome_observed",
] as const satisfies readonly AgentRuntimeEventV1["type"][];
export type DispatchLifecycleEventType = (typeof dispatchLifecycleEventTypes)[number];
export type DispatchLifecycleEvent = Extract<AgentRuntimeEventV1, { readonly type: DispatchLifecycleEventType }>;

export interface DispatchLifecycleAttempt {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  /** `local` for the center launcher, `node:<id>` for a fleet node, `other` for imported sources. */
  readonly owner: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly phase: DispatchAttemptPhase;
  readonly process: DispatchProcessObservation;
  /** The owner observed the provider process end; only then is the provider slot released. */
  readonly stopProven: boolean;
  readonly outcome: DispatchAttemptOutcome | null;
  readonly admittedRevision: number;
}

export interface DispatchLifecycleGroup {
  readonly attemptGroupId: string;
  readonly phase: DispatchGroupPhase;
  readonly currentDispatchId: string;
  readonly attempts: readonly DispatchLifecycleAttempt[];
  /**
   * A successor attempt may join: the group waits for a scheduled fallback, or its last attempt
   * was closed by a historical publisher that predates attempt classification (no `attempt`
   * field), whose fallback successors joined the same group without a `scheduled` marker.
   */
  readonly successorAdmissible: boolean;
  /** Revision of the last event this group accepted; replays at or below it are no-ops. */
  readonly revision: number;
}

export type DispatchLifecycleRejection =
  | "dispatch_group_busy"
  | "dispatch_attempt_closed"
  | "dispatch_attempt_superseded"
  | "dispatch_transition_illegal";

export type DispatchLifecycleStep =
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly code: DispatchLifecycleRejection; readonly reason: string }
  | { readonly kind: "applied"; readonly group: DispatchLifecycleGroup };

/** Which aggregate an event addresses; storage resolves it before calling the reducer. */
export type DispatchLifecycleAddress =
  | { readonly by: "group"; readonly attemptGroupId: string }
  | { readonly by: "session"; readonly runtimeSessionId: string };

export function isDispatchLifecycleEvent(event: AgentRuntimeEventV1): event is DispatchLifecycleEvent {
  return (dispatchLifecycleEventTypes as readonly string[]).includes(event.type);
}

export function dispatchLifecycleAddress(event: AgentRuntimeEventV1): DispatchLifecycleAddress | null {
  if (!isDispatchLifecycleEvent(event)) return null;
  if (event.type === "runtime_dispatch_requested")
    return { by: "group", attemptGroupId: event.payload.attemptGroupId ?? event.payload.dispatchId };
  return { by: "session", runtimeSessionId: event.payload.runtimeSessionId };
}

export function dispatchOwner(source: WriteSource): string {
  if (source === "local") return "local";
  return typeof source === "object" && source.kind === "node" ? `node:${source.nodeId}` : "other";
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
 * Fold one accepted runtime event into its group. `group` is the aggregate the event's
 * address resolves to (null when none exists). Session events for a session no dispatch admitted
 * (historical undispatched sessions) are ignored: they never were a dispatch.
 */
export function reduceDispatchLifecycle(
  group: DispatchLifecycleGroup | null,
  event: AgentRuntimeEventV1,
): DispatchLifecycleStep {
  if (!isDispatchLifecycleEvent(event)) return ignored;
  const revision = event.workspaceRevision;
  if (group !== null && revision <= group.revision) return ignored;
  if (event.type === "runtime_dispatch_requested") return admit(group, event, revision);
  if (group === null) return ignored;
  const attempt = group.attempts.find(({ runtimeSessionId }) => runtimeSessionId === event.payload.runtimeSessionId);
  if (!attempt) return ignored;
  if (attempt.phase === "closed")
    return reject(
      "dispatch_attempt_closed",
      `Dispatch ${attempt.dispatchId} is closed; a late ${event.type} cannot reopen it.`,
    );
  if (attempt.dispatchId !== group.currentDispatchId)
    return reject(
      "dispatch_attempt_superseded",
      `Dispatch ${attempt.dispatchId} is no longer the current attempt of group ${group.attemptGroupId}.`,
    );
  const next = advanceAttempt(attempt, event);
  if (next === null)
    return reject(
      "dispatch_transition_illegal",
      `${event.type} is not legal while dispatch ${attempt.dispatchId} is ${attempt.phase}.`,
    );
  const attempts = group.attempts.map((entry) => (entry === attempt ? next : entry)),
    phase = groupPhase(next, event);
  return {
    kind: "applied",
    group: {
      ...group,
      attempts,
      phase,
      successorAdmissible:
        phase === "waiting_backoff" ||
        (phase === "closed" &&
          event.type === "runtime_session_outcome_observed" &&
          event.payload.attempt === undefined),
      revision,
    },
  };
}

function admit(
  group: DispatchLifecycleGroup | null,
  event: Extract<DispatchLifecycleEvent, { readonly type: "runtime_dispatch_requested" }>,
  revision: number,
): DispatchLifecycleStep {
  const payload = event.payload,
    attempt: DispatchLifecycleAttempt = {
      dispatchId: payload.dispatchId,
      runtimeSessionId: payload.runtimeSessionId,
      instanceId: payload.instanceId,
      owner: dispatchOwner(event.source),
      taskId: payload.taskId ?? null,
      executionId: payload.executionId ?? null,
      phase: "starting",
      process: "unobserved",
      stopProven: false,
      outcome: null,
      admittedRevision: revision,
    };
  if (group === null)
    return {
      kind: "applied",
      group: {
        attemptGroupId: payload.attemptGroupId ?? payload.dispatchId,
        phase: "starting",
        currentDispatchId: payload.dispatchId,
        attempts: [attempt],
        successorAdmissible: false,
        revision,
      },
    };
  if (!group.successorAdmissible)
    return reject(
      "dispatch_group_busy",
      `Group ${group.attemptGroupId} is ${group.phase}; only a waiting fallback group admits a successor.`,
    );
  return {
    kind: "applied",
    group: {
      ...group,
      phase: "starting",
      currentDispatchId: payload.dispatchId,
      attempts: [...group.attempts, attempt],
      successorAdmissible: false,
      revision,
    },
  };
}

function advanceAttempt(
  attempt: DispatchLifecycleAttempt,
  event: DispatchLifecycleEvent,
): DispatchLifecycleAttempt | null {
  switch (event.type) {
    case "runtime_session_started":
      if (attempt.phase !== "starting" && attempt.phase !== "running") return null;
      return { ...attempt, phase: "running", process: attempt.process === "unknown" ? "unknown" : "alive" };
    case "runtime_session_liveness_changed":
      if (attempt.process === "exited") return attempt;
      return { ...attempt, process: event.payload.liveness === "live" ? "alive" : "unknown" };
    case "runtime_session_cancelled":
      // A cancel request does not prove the provider stopped; the slot stays held.
      return { ...attempt, phase: "settling" };
    case "runtime_session_exited":
      return { ...attempt, phase: "settling", process: "exited", stopProven: true };
    case "runtime_session_outcome_observed":
      // Historical owners publish the outcome only after their settlement finished with the process.
      return { ...attempt, phase: "closed", stopProven: true, outcome: event.payload.outcome };
    default:
      return null;
  }
}

function groupPhase(attempt: DispatchLifecycleAttempt, event: DispatchLifecycleEvent): DispatchGroupPhase {
  if (attempt.phase !== "closed") return attempt.phase;
  if (event.type !== "runtime_session_outcome_observed") return "closed";
  if (event.payload.attempt?.fallbackState === "scheduled") return "waiting_backoff";
  if (event.payload.attempt?.classification === "awaiting_ruling") return "awaiting_ruling";
  return "closed";
}

export function currentDispatchAttempt(group: DispatchLifecycleGroup): DispatchLifecycleAttempt {
  return group.attempts.find(({ dispatchId }) => dispatchId === group.currentDispatchId)!;
}

/** The one capacity judgment: a provider slot is free once the owner observed the process end. */
export function dispatchCapacityDisposition(attempt: DispatchLifecycleAttempt): DispatchCapacityDisposition {
  if (attempt.phase === "closed" || attempt.stopProven) return "free";
  return attempt.process === "unknown" ? "recovering" : "busy";
}

export interface DispatchAdmissionBlocker {
  readonly code: "runtime_recovery_pending";
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly message: string;
}

/**
 * Admission on one instance is refused only while this owner has an attempt there whose
 * process it cannot observe and has not proven stopped. Running attempts and other owners'
 * attempts never block: there is no per-instance concurrency limit to protect.
 */
export function dispatchAdmissionBlocker(
  views: readonly DispatchLifecycleView[],
  input: { readonly instanceId: string; readonly owner: string },
): DispatchAdmissionBlocker | null {
  for (const view of views) {
    const attempt = view.attempt;
    if (attempt.instanceId !== input.instanceId || attempt.owner !== input.owner) continue;
    if (view.policy.capacityDisposition !== "recovering") continue;
    return {
      code: "runtime_recovery_pending",
      dispatchId: attempt.dispatchId,
      runtimeSessionId: attempt.runtimeSessionId,
      message: `Runtime ${attempt.runtimeSessionId} has unresolved capacity: its owner cannot observe the provider process.`,
    };
  }
  return null;
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
  readonly revision: number;
  readonly policy: {
    readonly attemptSettled: boolean;
    readonly groupSettled: boolean;
    readonly capacityDisposition: DispatchCapacityDisposition;
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
    currentDispatchAttempt(group);
  return {
    attemptGroupId: group.attemptGroupId,
    groupPhase: group.phase,
    attempt,
    revision: group.revision,
    policy: {
      attemptSettled: attempt.phase === "closed",
      groupSettled: group.phase === "closed",
      capacityDisposition: dispatchCapacityDisposition(attempt),
    },
  };
}

/** Every group that is not closed belongs to the active index; storage pages it by group id. */
export function dispatchGroupIsActive(group: DispatchLifecycleGroup): boolean {
  return group.phase !== "closed";
}

export const DISPATCH_LIFECYCLE_PAGE_LIMIT = 100;
