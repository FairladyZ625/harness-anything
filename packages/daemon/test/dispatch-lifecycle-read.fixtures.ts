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
  return async (query: DispatchLifecycleQuery): Promise<DispatchLifecycleRead> => {
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
    const rows = [...groups.values()]
      .filter((group) => query.by !== "active" || group.phase !== "closed")
      .map((group) => dispatchLifecycleView(group))
      .filter(
        (view) =>
          query.by !== "active" || query.instanceId === undefined || view.attempt.instanceId === query.instanceId,
      );
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
      ...(type === "R" ? { dispatchId: `dispatch-${runtimeSessionId}`, instanceId: options.instanceId } : {}),
      ...(type === "S" ? { launchGeneration: 1 } : {}),
      ...(type === "L" ? { liveness: options.liveness ?? "live" } : {}),
      ...(type === "O" ? { outcome: "succeeded", exitCode: 0, resultRef: "artifact:none", result: null } : {}),
    },
  } as unknown as AgentRuntimeEventV1;
}
