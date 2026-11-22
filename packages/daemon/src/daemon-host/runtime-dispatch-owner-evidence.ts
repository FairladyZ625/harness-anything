import { sameWriteSource, type TaskProjection } from "@harness-anything/kernel";
import type { RuntimeDispatchOwnerEvidence } from "./runtime-spawn-types.ts";
import { readDispatchStreamSummary } from "./dispatch-stream.ts";
import { observeRecordedProcessGroup } from "./runtime/process-group-reconciler.ts";

export type RuntimeDispatchOwner = Omit<RuntimeDispatchOwnerEvidence, "processGroupPid">;

/** Point-lookup of the canonical dispatch owner without scanning session liveness history. */
export function readRuntimeDispatchOwner(
  projection: Pick<TaskProjection, "readRuntimeSession" | "readRuntimeDispatch">,
  runtimeSessionId: string,
): RuntimeDispatchOwner | null {
  const session = projection.readRuntimeSession(runtimeSessionId);
  if (!session) return null;
  const dispatch = projection.readRuntimeDispatch(runtimeSessionId, session.definitionSnapshotRef);
  if (!dispatch) return null;
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
  };
}

export function readRuntimeDispatchOwnerEvidence(
  projection: Pick<TaskProjection, "readRuntimeSession" | "readRuntimeDispatch" | "readRuntimeSessionEventsByType">,
  runtimeSessionId: string,
): RuntimeDispatchOwnerEvidence | null {
  const owner = readRuntimeDispatchOwner(projection, runtimeSessionId);
  if (!owner) return null;
  const livenessEvent = projection
    .readRuntimeSessionEventsByType(runtimeSessionId, ["runtime_session_liveness_changed"])
    .findLast(
      (event) =>
        event.type === "runtime_session_liveness_changed" &&
        sameWriteSource(event.source, owner.source) &&
        Number.isSafeInteger(event.payload.processGroupPid) &&
        Number(event.payload.processGroupPid) > 1,
    );
  const processGroupPid =
    livenessEvent?.type === "runtime_session_liveness_changed" ? (livenessEvent.payload.processGroupPid ?? null) : null;
  return {
    ...owner,
    processGroupPid,
  };
}

/** The caller has matched the canonical owner to this host before observing its OS. */
export function observeRuntimeDispatchOwnerGroup(rootDir: string, dispatchId: string, recordedPid: number | null) {
  const pgid = recordedPid ?? readDispatchStreamSummary(rootDir, dispatchId)?.process?.pid;
  return observeRecordedProcessGroup({ pgid, dispatch: { rootDir, dispatchId } });
}
