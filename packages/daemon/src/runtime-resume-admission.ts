import path from "node:path";
import type { TaskProjection } from "@harness-anything/kernel";
import { readDispatchStream, readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { resolveRuntimeCwd } from "./runtime-spawn-mission.ts";
import { requiredRuntimeProjection } from "./runtime-spawn-process.ts";
import { materializeTaskWorktree, presetSnapshotReader } from "./task-worktree.ts";

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

/**
 * A resumed dispatch without a requested cwd keeps its own. A local task dispatch without one runs in the task's
 * worktree (dec_BBA713052997C3EF5F5D3DD952), checked out here on first use; a reviewer, a dry-run preview and
 * anything else start at the repository root.
 */
export async function resolveDispatchCwd(
  input: { readonly rootDir: string; readonly remote?: unknown; readonly projection?: () => TaskProjection },
  payload: { readonly cwd?: unknown; readonly role?: unknown; readonly dryRun?: unknown },
  inherited: string | undefined,
  taskId: string | null,
): Promise<string> {
  if (payload.cwd === undefined && inherited) return inherited;
  const worktree =
    payload.cwd === undefined && taskId && !input.remote && payload.role !== "reviewer" && payload.dryRun !== true
      ? await checkoutTaskWorktree(input.rootDir, requiredRuntimeProjection(input), taskId)
      : null;
  return resolveRuntimeCwd(
    input.rootDir,
    worktree
      ? { scope: "repo-relative", path: path.relative(input.rootDir, worktree.cwd) }
      : (payload.cwd ?? { scope: "repo-root" }),
  );
}

function checkoutTaskWorktree(rootDir: string, projection: TaskProjection, taskId: string) {
  return materializeTaskWorktree(
    rootDir,
    requireCurrentTaskProjection(projection, taskId, "runtime.run").snapshot.task,
    presetSnapshotReader(projection),
  );
}
