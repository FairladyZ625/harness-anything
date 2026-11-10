import {
  dispatchLifecycleAddress,
  dispatchLifecycleView,
  reduceDispatchLifecycle,
  type AgentRuntimeEventV1,
  type DispatchLifecycleGroup,
  type DispatchLifecycleQuery,
  type DispatchLifecycleRead,
  type DispatchLifecycleView,
} from "@harness-anything/kernel";
import { isDispatchLifecycleInput } from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";

export const emptyDispatchLifecycleRead = async (): Promise<DispatchLifecycleRead> => ({
  status: "ready",
  watermark: 0,
  sourceRevision: 0,
  rows: [],
  nextCursor: null,
});

/** Small read-port fixture for tests whose stream is the source of observations. */
export function lifecycleReadFor(
  entries: readonly {
    readonly runtimeSessionId: string;
    readonly dispatchId: string;
    readonly instanceId?: string;
    readonly owner?: string;
    readonly attemptSettled?: boolean;
    readonly groupSettled?: boolean;
    readonly process?: "unobserved" | "alive" | "unknown" | "exited";
    readonly stopProof?: "unproven" | "proven_stopped";
    readonly outcome?: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null;
  }[],
) {
  const views: DispatchLifecycleView[] = entries.map((entry) => {
    const attemptSettled = entry.attemptSettled ?? false,
      groupSettled = entry.groupSettled ?? attemptSettled,
      owner = entry.owner ?? "local",
      process = entry.process ?? (attemptSettled ? "exited" : "unknown"),
      stopProof = entry.stopProof ?? (attemptSettled ? "proven_stopped" : "unproven"),
      phase = attemptSettled ? "closed" : "running",
      outcome = entry.outcome ?? (attemptSettled ? "succeeded" : null),
      attempt = {
        dispatchId: entry.dispatchId,
        runtimeSessionId: entry.runtimeSessionId,
        instanceId: entry.instanceId ?? "worker",
        fence: { owner, verified: true, token: 1, epoch: 1 },
        reservation: {
          reservationId: `reservation-${entry.dispatchId}`,
          instanceId: entry.instanceId ?? "worker",
          owner,
        },
        task: null,
        workspaceRef: null,
        phase,
        process,
        stopProof,
        outcome,
        admittedRevision: 1,
        eventIds: [],
      };
    return {
      attemptGroupId: entry.dispatchId,
      groupPhase: groupSettled ? "closed" : phase === "running" ? "running" : "starting",
      attempt,
      successor: { admissible: !groupSettled, dueAt: null },
      ruling: null,
      delivery: { status: "unregistered", targetRef: null, targetDigest: null, registeredRevision: null },
      revision: 1,
      policy: {
        attemptSettled,
        groupSettled,
        capacity: attemptSettled ? "released" : "held",
        capacityDisposition: attemptSettled ? "free" : "recovering",
        successorAdmissible: !groupSettled,
        canResolveRuling: false,
        canRecover: attemptSettled && stopProof === "proven_stopped",
        blockerCode: attemptSettled ? null : "runtime_recovery_pending",
      },
    } as DispatchLifecycleView;
  });
  return async (query: DispatchLifecycleQuery): Promise<DispatchLifecycleRead> => {
    let rows: readonly DispatchLifecycleView[];
    if (query.by === "session")
      rows = views.filter(({ attempt }) => attempt.runtimeSessionId === query.runtimeSessionId);
    else if (query.by === "dispatch")
      rows = views.filter(({ attempt }) => query.dispatchIds.includes(attempt.dispatchId));
    else if (query.by === "group") rows = views.filter(({ attemptGroupId }) => attemptGroupId === query.attemptGroupId);
    else
      rows = views.filter(({ attempt }) => query.instanceId === undefined || attempt.instanceId === query.instanceId);
    if (query.by === "active") rows = rows.filter(({ policy }) => !policy.groupSettled);
    return { status: "ready", watermark: 1, sourceRevision: 1, rows, nextCursor: null };
  };
}

/** A test read port over accepted runtime events: the same kernel fold the projections run. */
export function dispatchLifecycleReadOf(events: () => readonly AgentRuntimeEventV1[]) {
  return (query: DispatchLifecycleQuery): DispatchLifecycleRead => {
    const groups = new Map<string, DispatchLifecycleGroup>(),
      bySession = new Map<string, string>();
    for (const event of events()) {
      if (!isDispatchLifecycleInput(event)) continue;
      const address = dispatchLifecycleAddress(event);
      if (address === null) continue;
      const id = address.by === "group" ? address.attemptGroupId : bySession.get(address.runtimeSessionId),
        step = reduceDispatchLifecycle(id === undefined ? null : (groups.get(id) ?? null), event);
      if (step.kind !== "applied") continue;
      groups.set(step.group.attemptGroupId, step.group);
      for (const attempt of step.group.attempts) bySession.set(attempt.runtimeSessionId, step.group.attemptGroupId);
    }
    const viewForAttempt = (group: DispatchLifecycleGroup, dispatchId: string): DispatchLifecycleView =>
      dispatchLifecycleView(group, dispatchId);
    let rows: DispatchLifecycleView[];
    if (query.by === "dispatch")
      rows = query.dispatchIds.flatMap((dispatchId) => {
        const group = [...groups.values()].find((entry) =>
          entry.attempts.some((attempt) => attempt.dispatchId === dispatchId),
        );
        return group ? [viewForAttempt(group, dispatchId)] : [];
      });
    else if (query.by === "session") {
      const groupId = bySession.get(query.runtimeSessionId),
        group = groupId === undefined ? undefined : groups.get(groupId),
        attempt = group?.attempts.find((entry) => entry.runtimeSessionId === query.runtimeSessionId);
      rows = group && attempt ? [viewForAttempt(group, attempt.dispatchId)] : [];
    } else if (query.by === "group") {
      const group = groups.get(query.attemptGroupId);
      rows = group ? [dispatchLifecycleView(group)] : [];
    } else {
      const active = [...groups.values()]
        .filter(
          (group) =>
            group.phase !== "closed" &&
            (query.instanceId === undefined || dispatchLifecycleView(group).attempt.instanceId === query.instanceId),
        )
        .sort((a, b) => (a.attemptGroupId < b.attemptGroupId ? -1 : 1))
        .filter((group) => query.cursor === undefined || group.attemptGroupId > query.cursor);
      rows = active.slice(0, query.limit).map((group) => dispatchLifecycleView(group));
      const nextCursor = active.length > query.limit ? (rows.at(-1)?.attemptGroupId ?? null) : null;
      return { status: "ready", watermark: 0, sourceRevision: 0, rows, nextCursor };
    }
    return { status: "ready", watermark: 0, sourceRevision: 0, rows, nextCursor: null };
  };
}

let revision = 0;
/** A minimal accepted runtime event; the lifecycle fold reads only these fields. */
export function lifecycleEvent(
  type: "R" | "S" | "L" | "X" | "O",
  runtimeSessionId: string,
  options: {
    readonly instanceId: string;
    readonly source: AgentRuntimeEventV1["source"];
    readonly dispatchId?: string;
    readonly liveness?: "live" | "unknown";
  },
): AgentRuntimeEventV1 {
  revision += 1;
  const types = {
    R: "runtime_dispatch_requested",
    S: "runtime_session_started",
    L: "runtime_session_liveness_changed",
    X: "runtime_session_exited",
    O: "runtime_session_outcome_observed",
  } as const;
  return {
    schema: "agent-runtime-event/v1",
    eventId: `lifecycle-${revision}`,
    workspaceRevision: revision,
    opId: `lifecycle-op-${revision}`,
    type: types[type],
    actor: { principal: { personId: "owner" }, executor: null },
    source: options.source,
    occurredAt: "2026-11-08T00:00:00.000Z",
    payload: {
      runtimeSessionId,
      ...(type === "R"
        ? { dispatchId: options.dispatchId ?? `dispatch-${runtimeSessionId}`, instanceId: options.instanceId }
        : {}),
      ...(type === "S" ? { launchGeneration: 1 } : {}),
      ...(type === "L" ? { liveness: options.liveness ?? "live" } : {}),
      ...(type === "O" ? { outcome: "succeeded", exitCode: 0, resultRef: "artifact:none", result: null } : {}),
    },
  } as unknown as AgentRuntimeEventV1;
}
