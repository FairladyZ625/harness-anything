import { readDispatchStream, readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { resolveRuntimeCwd } from "./runtime-spawn-mission.ts";

export function admitRuntimeResume(rootDir: string, dispatchId: string | undefined) {
  const resumed = dispatchId ? readDispatchStream(rootDir, dispatchId) : null;
  if (dispatchId && !resumed?.providerSessionId)
    throw runtimeSpawnError(
      "runtime_dispatch_not_resumable",
      `Dispatch ${dispatchId} has no provider session to resume.`,
    );
  const priorResume = dispatchId
    ? readDispatchStreamHeaders(rootDir).find((header) => header.resumedFromDispatchId === dispatchId)
    : undefined;
  if (priorResume)
    throw runtimeSpawnError(
      "runtime_dispatch_already_resumed",
      `Dispatch ${dispatchId} was already resumed as ${priorResume.dispatchId}.`,
      {
        kind: "validation",
        entity: dispatchId!,
        field: "dispatchId",
        actual: priorResume.dispatchId,
        expectation:
          `Resume the existing dispatch ${priorResume.dispatchId}; ` + "the source dispatch can only be resumed once.",
      },
    );
  return resumed;
}

export function requestedResumeDispatchId(payload: {
  readonly dispatchId?: unknown;
  readonly resumeDispatchId?: unknown;
}) {
  if (payload.dispatchId !== undefined && payload.resumeDispatchId !== undefined)
    throw runtimeSpawnError("invalid_runtime_spawn", "Runtime spawn accepts one resume dispatch id.");
  const value = payload.resumeDispatchId ?? payload.dispatchId;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0)
    throw runtimeSpawnError("invalid_runtime_spawn", "resumeDispatchId is required.");
  return value;
}

/** Read-side counterpart to resume admission. Keep this predicate aligned with the write
 * admission above so callers do not reconstruct resumability from projection fragments. */
export function resumableRuntimeDispatch(
  rootDir: string,
  dispatchId: string,
): { readonly dispatchId: string; readonly agentId: string | null } | undefined {
  const resumed = readDispatchStream(rootDir, dispatchId);
  if (!resumed?.providerSessionId) return undefined;
  if (readDispatchStreamHeaders(rootDir).some((header) => header.resumedFromDispatchId === dispatchId))
    return undefined;
  return { dispatchId, agentId: resumed.header.agentId ?? null };
}

export function assertResumeAgent(
  dispatchId: string | undefined,
  inheritedAgentId: string | undefined,
  requestedAgentId: unknown,
  resolvedAgentId: string | undefined,
): void {
  if (requestedAgentId === undefined || !inheritedAgentId || resolvedAgentId === inheritedAgentId) return;
  throw runtimeSpawnError(
    "runtime_resume_agent_mismatch",
    `Dispatch ${dispatchId} belongs to agent ${inheritedAgentId}, not ${resolvedAgentId}.`,
  );
}

export function resolveResumeCwd(rootDir: string, requested: unknown, inherited: string | undefined): string {
  return requested === undefined && inherited ? inherited : resolveRuntimeCwd(rootDir, requested);
}
