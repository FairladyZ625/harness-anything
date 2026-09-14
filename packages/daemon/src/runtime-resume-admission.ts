import { readDispatchStream, readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { resolveRuntimeCwd } from "./runtime-spawn-mission.ts";

export function admitRuntimeResume(rootDir: string, dispatchId: string | undefined) {
  const resumed = dispatchId ? readDispatchStream(rootDir, dispatchId) : null;
  if (!dispatchId) return resumed;
  const admission = runtimeResumeAdmission({
    dispatchId,
    agentId: resumed?.header.agentId ?? null,
    providerSessionId: resumed?.providerSessionId ?? null,
    resumedDispatches: resumedDispatchesBySource(readDispatchStreamHeaders(rootDir)),
  });
  if (!admission.resumable && admission.reason === "missing_provider_session")
    throw runtimeSpawnError(
      "runtime_dispatch_not_resumable",
      `Dispatch ${dispatchId} has no provider session to resume.`,
    );
  if (!admission.resumable && admission.reason === "already_resumed")
    throw runtimeSpawnError(
      "runtime_dispatch_already_resumed",
      `Dispatch ${dispatchId} was already resumed as ${admission.resumedDispatchId}.`,
      {
        kind: "validation",
        entity: dispatchId,
        field: "dispatchId",
        actual: admission.resumedDispatchId,
        expectation:
          `Resume the existing dispatch ${admission.resumedDispatchId}; ` +
          "the source dispatch can only be resumed once.",
      },
    );
  return resumed;
}

export type RuntimeResumeAdmission =
  | { readonly resumable: true; readonly dispatchId: string; readonly agentId: string | null }
  | { readonly resumable: false; readonly reason: "missing_provider_session" }
  | { readonly resumable: false; readonly reason: "already_resumed"; readonly resumedDispatchId: string };

export function resumedDispatchesBySource(
  headers: readonly { readonly dispatchId: string; readonly resumedFromDispatchId?: string }[],
): ReadonlyMap<string, string> {
  return new Map(
    headers.flatMap((header) =>
      header.resumedFromDispatchId === undefined ? [] : [[header.resumedFromDispatchId, header.dispatchId] as const],
    ),
  );
}

/** The only resume decision point. Read paths supply already-read data and do not reopen streams. */
export function runtimeResumeAdmission(input: {
  readonly dispatchId: string;
  readonly agentId: string | null;
  readonly providerSessionId: string | null;
  readonly resumedDispatches: ReadonlyMap<string, string>;
}): RuntimeResumeAdmission {
  if (!input.providerSessionId) return { resumable: false, reason: "missing_provider_session" };
  const resumedDispatchId = input.resumedDispatches.get(input.dispatchId);
  if (resumedDispatchId) return { resumable: false, reason: "already_resumed", resumedDispatchId };
  return { resumable: true, dispatchId: input.dispatchId, agentId: input.agentId };
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
