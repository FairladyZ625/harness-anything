import {
  dispatchLifecycleAddress,
  dispatchLifecycleView,
  reduceDispatchLifecycle,
  type AgentRuntimeEventV1,
  type DispatchLifecycleGroup,
  type DispatchLifecycleQuery,
  type DispatchLifecycleRead,
} from "@harness-anything/kernel";
import { isDispatchLifecycleInput } from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";

export const emptyDispatchLifecycleRead = async (): Promise<DispatchLifecycleRead> => ({
  status: "ready",
  watermark: 0,
  sourceRevision: 0,
  rows: [],
  nextCursor: null,
});

/** A test read port over accepted runtime events: the same kernel fold the projections run. */
export function dispatchLifecycleReadOf(events: () => readonly AgentRuntimeEventV1[]) {
  return (query: DispatchLifecycleQuery): DispatchLifecycleRead => {
    const groups = new Map<string, DispatchLifecycleGroup>(),
      bySession = new Map<string, { readonly groupId: string; readonly dispatchId: string }>();
    for (const event of events()) {
      if (!isDispatchLifecycleInput(event)) continue;
      const address = dispatchLifecycleAddress(event);
      if (address === null) continue;
      const id = address.by === "group" ? address.attemptGroupId : bySession.get(address.runtimeSessionId)?.groupId,
        step = reduceDispatchLifecycle(id === undefined ? null : (groups.get(id) ?? null), event);
      if (step.kind !== "applied") continue;
      groups.set(step.group.attemptGroupId, step.group);
      for (const attempt of step.group.attempts)
        bySession.set(attempt.runtimeSessionId, {
          groupId: step.group.attemptGroupId,
          dispatchId: attempt.dispatchId,
        });
    }
    if (query.by === "active") {
      const active = [...groups.values()]
        .filter(
          (group) =>
            group.phase !== "closed" &&
            (query.instanceId === undefined || dispatchLifecycleView(group).attempt.instanceId === query.instanceId),
        )
        .sort((a, b) => (a.attemptGroupId < b.attemptGroupId ? -1 : 1))
        .filter((group) => query.cursor === undefined || group.attemptGroupId > query.cursor);
      const rows = active.slice(0, query.limit).map((group) => dispatchLifecycleView(group));
      return {
        status: "ready",
        watermark: 0,
        sourceRevision: 0,
        rows,
        nextCursor: active.length > query.limit ? (rows.at(-1)?.attemptGroupId ?? null) : null,
      };
    }
    const rows =
      query.by === "session"
        ? (() => {
            const address = bySession.get(query.runtimeSessionId),
              group = address === undefined ? undefined : groups.get(address.groupId);
            return address === undefined || group === undefined
              ? []
              : [dispatchLifecycleView(group, address.dispatchId)];
          })()
        : query.by === "dispatch"
          ? [...groups.values()].flatMap((group) =>
              group.attempts
                .filter((attempt) => query.dispatchIds.includes(attempt.dispatchId))
                .map((attempt) => dispatchLifecycleView(group, attempt.dispatchId)),
            )
          : query.by === "group"
            ? (() => {
                const group = groups.get(query.attemptGroupId);
                return group === undefined ? [] : [dispatchLifecycleView(group)];
              })()
            : [];
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
    readonly liveness?: "live" | "unknown";
    readonly dispatchId?: string;
    readonly attemptGroupId?: string;
    readonly taskId?: string;
    readonly executionId?: string;
    readonly role?: "implementer" | "reviewer";
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
        ? {
            dispatchId: options.dispatchId ?? `dispatch-${runtimeSessionId}`,
            instanceId: options.instanceId,
            ...(options.attemptGroupId === undefined ? {} : { attemptGroupId: options.attemptGroupId }),
            ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
            ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
            ...(options.role === undefined ? {} : { role: options.role }),
          }
        : {}),
      ...(type === "S" ? { launchGeneration: 1 } : {}),
      ...(type === "L" ? { liveness: options.liveness ?? "live" } : {}),
      ...(type === "O" ? { outcome: "succeeded", exitCode: 0, resultRef: "artifact:none", result: null } : {}),
    },
  } as unknown as AgentRuntimeEventV1;
}
