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
