import { consumeKnownError, type AgentRuntimeEventV1 } from "@harness-anything/kernel";
import { runtimeErrorCode } from "../runtime-engine/runtime-spawn-errors.ts";

export type RemoteRuntimeControlEvent = Extract<
  AgentRuntimeEventV1,
  { readonly type: "runtime_cancel_requested" | "runtime_steer_requested" }
>;

const DEFAULT_MAX_TRACKED_CONTROL_REQUESTS = 4096;

/**
 * Edge-side event-driven consumer for Center-persisted runtime control requests (`runtime_cancel_requested`
 * and `runtime_steer_requested`).
 *
 * Complexity (G38):
 * - Zero full-history scans: when the node owns no active local runtime handles, `drain()` returns in O(1).
 * - When active local runtimes exist, only those `runtimeSessionId` keys are queried through the indexed
 *   `(runtimeSessionId, workspace_revision)` projection path, bounded by per-session revision watermarks
 *   and a bounded FIFO deduplication Set of `controlRequestId` values.
 */
export function createFleetEdgeRuntimeControlConsumer(input: {
  readonly nodeId: () => string;
  readonly activeRuntimeSessionIds: () => readonly string[];
  readonly readControlEvents: (runtimeSessionIds: readonly string[]) => Promise<readonly RemoteRuntimeControlEvent[]>;
  readonly executeCancel: (runtimeSessionId: string) => Promise<void>;
  readonly executeSteer: (
    event: Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_steer_requested" }>,
  ) => Promise<void>;
  readonly schedule: (work: () => void | Promise<void>) => Promise<void>;
  readonly maxTrackedControlRequests?: number;
}) {
  const maxTracked = Math.max(1, input.maxTrackedControlRequests ?? DEFAULT_MAX_TRACKED_CONTROL_REQUESTS),
    appliedControlRequestIds = new Set<string>(),
    lastRevisionBySession = new Map<string, number>();

  const rememberApplied = (controlRequestId: string): void => {
    appliedControlRequestIds.delete(controlRequestId);
    appliedControlRequestIds.add(controlRequestId);
    while (appliedControlRequestIds.size > maxTracked) {
      const oldest = appliedControlRequestIds.keys().next().value;
      if (oldest === undefined) break;
      appliedControlRequestIds.delete(oldest);
    }
  };

  const advanceSessionRevision = (runtimeSessionId: string, revision: number): void => {
    const previous = lastRevisionBySession.get(runtimeSessionId) ?? 0;
    if (revision > previous) lastRevisionBySession.set(runtimeSessionId, revision);
  };

  return {
    drain: async (): Promise<void> => {
      const activeIds = input.activeRuntimeSessionIds();
      const activeSet = new Set(activeIds);
      for (const sessionId of lastRevisionBySession.keys())
        if (!activeSet.has(sessionId)) lastRevisionBySession.delete(sessionId);
      if (activeIds.length === 0) return;

      const localNodeId = input.nodeId();
      const events = await input.readControlEvents(activeIds);
      const pending = events
        .filter((event) => {
          const sid = event.payload.runtimeSessionId;
          if (!activeSet.has(sid)) return false;
          if (event.payload.targetNodeId !== localNodeId) return false;
          if (event.workspaceRevision <= (lastRevisionBySession.get(sid) ?? 0)) return false;
          if (appliedControlRequestIds.has(event.payload.controlRequestId)) return false;
          return true;
        })
        .sort((left, right) => left.workspaceRevision - right.workspaceRevision);
      if (pending.length === 0) return;

      await input.schedule(async () => {
        for (const event of pending) {
          const { runtimeSessionId, controlRequestId } = event.payload;
          if (appliedControlRequestIds.has(controlRequestId)) continue;
          if (!input.activeRuntimeSessionIds().includes(runtimeSessionId)) {
            rememberApplied(controlRequestId);
            advanceSessionRevision(runtimeSessionId, event.workspaceRevision);
            continue;
          }
          if (event.type === "runtime_cancel_requested") {
            rememberApplied(controlRequestId);
            advanceSessionRevision(runtimeSessionId, event.workspaceRevision);
            try {
              await input.executeCancel(runtimeSessionId);
            } catch (error) {
              consumeKnownError(error);
              const code = runtimeErrorCode(error);
              if (code !== "runtime_not_running")
                console.error(
                  `[fleet-edge-runtime-control] Remote cancel ${controlRequestId} for ${runtimeSessionId} failed:`,
                  error,
                );
            }
            continue;
          }
          try {
            await input.executeSteer(event);
            rememberApplied(controlRequestId);
            advanceSessionRevision(runtimeSessionId, event.workspaceRevision);
          } catch (error) {
            consumeKnownError(error);
            const code = runtimeErrorCode(error);
            if (code === "runtime_steer_unavailable" && input.activeRuntimeSessionIds().includes(runtimeSessionId)) {
              // Transient pre-bind race: keep controlRequestId unmarked so the next reconcile retries.
              continue;
            }
            rememberApplied(controlRequestId);
            advanceSessionRevision(runtimeSessionId, event.workspaceRevision);
            if (
              code !== "runtime_not_running" &&
              code !== "runtime_steer_unsupported" &&
              code !== "runtime_steer_target_changed"
            )
              console.error(
                `[fleet-edge-runtime-control] Remote steer ${controlRequestId} for ${runtimeSessionId} failed:`,
                error,
              );
          }
        }
      });
    },
  };
}
