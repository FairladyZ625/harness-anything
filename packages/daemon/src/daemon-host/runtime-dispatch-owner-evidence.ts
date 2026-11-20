import { sameWriteSource, type TaskProjection } from "@harness-anything/kernel";
import type { RuntimeDispatchOwnerEvidence } from "./runtime-spawn-types.ts";
import { readDispatchStreamSummary } from "./dispatch-stream.ts";
import { observeRecordedProcessGroup } from "./runtime/process-group-reconciler.ts";

export function readRuntimeDispatchOwnerEvidence(
  projection: Pick<TaskProjection, "readRuntimeSession" | "readRuntimeDispatch" | "readRuntimeSessionEventsByType">,
  runtimeSessionId: string,
): RuntimeDispatchOwnerEvidence | null {
  const session = projection.readRuntimeSession(runtimeSessionId);
  if (!session) return null;
  const dispatch = projection.readRuntimeDispatch(runtimeSessionId, session.definitionSnapshotRef);
  if (!dispatch) return null;
  const livenessEvent = projection
    .readRuntimeSessionEventsByType(runtimeSessionId, ["runtime_session_liveness_changed"])
    .findLast(
      (event) =>
        event.type === "runtime_session_liveness_changed" &&
        sameWriteSource(event.source, dispatch.source) &&
        Number.isSafeInteger(event.payload.processGroupPid) &&
        Number(event.payload.processGroupPid) > 1,
    );
  const processGroupPid =
    livenessEvent?.type === "runtime_session_liveness_changed" ? (livenessEvent.payload.processGroupPid ?? null) : null;
  return {
    actor: dispatch.actor,
    source: dispatch.source,
    payload: {
      dispatchId: dispatch.payload.dispatchId,
      ...(dispatch.payload.taskId !== undefined ? { taskId: dispatch.payload.taskId } : {}),
      ...(dispatch.payload.agentId !== undefined ? { agentId: dispatch.payload.agentId } : {}),
      ...(dispatch.payload.agentDeclarationDigest !== undefined
        ? { agentDeclarationDigest: dispatch.payload.agentDeclarationDigest }
        : {}),
      ...(dispatch.payload.skillSnapshotDigest !== undefined
        ? { skillSnapshotDigest: dispatch.payload.skillSnapshotDigest }
        : {}),
    },
    instanceId: dispatch.payload.instanceId,
    processGroupPid,
  };
}

/** The caller has matched the canonical owner to this host before observing its OS. */
export function observeRuntimeDispatchOwnerGroup(rootDir: string, dispatchId: string, recordedPid: number | null) {
  const pgid = recordedPid ?? readDispatchStreamSummary(rootDir, dispatchId)?.process?.pid;
  return observeRecordedProcessGroup({ pgid, dispatch: { rootDir, dispatchId } });
}
