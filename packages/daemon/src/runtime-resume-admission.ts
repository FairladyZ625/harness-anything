import { validSquadDispatchContext } from "@harness-anything/kernel";
import { unknownFieldViolation } from "./protocol/json-rpc-types.ts";
import { readHandoffCheckpoint } from "./runtime-handoff-store.ts";
import path from "node:path";
import type { SettingsV1, TaskProjection, TaskWorktreeBindingV1 } from "@harness-anything/kernel";
import { readDispatchStream } from "./dispatch-stream.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { resolveRuntimeCwd } from "./runtime-spawn-mission.ts";
import { requiredRuntimeProjection } from "./runtime-spawn-process.ts";
import {
  checkoutTaskWorktree,
  openTaskWorktreeBinding,
  presetSnapshotReader,
  type TaskWorktreeCheckout,
} from "./task-worktree.ts";
import { worktreeSetupFailure } from "./worktree-setup.ts";

export function admitRuntimeResume(
  rootDir: string,
  dispatchId: string | undefined,
  projection: (() => Pick<TaskProjection, "readRuntimeDispatchByResumeSource">) | null,
) {
  const resumed = dispatchId ? readDispatchStream(rootDir, dispatchId) : null;
  if (!dispatchId) return resumed;
  if (readHandoffCheckpoint(rootDir, dispatchId))
    throw runtimeSpawnError(
      "runtime_handoff_source_exported",
      "This dispatch was exported; use the target handoff claim action.",
    );
  // On an edge the center checks consumption atomically when accepting the dispatch.
  const resumedDispatch = projection?.().readRuntimeDispatchByResumeSource(dispatchId);
  const admission = runtimeResumeAdmission({
    dispatchId,
    agentId: resumed?.header.agentId ?? null,
    providerSessionId: resumed?.providerSessionId ?? null,
    resumedDispatches: resumedDispatchesBySource(resumedDispatch ? [resumedDispatch.event.payload] : []),
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

/** Stream-backed admission and read models share this availability judgment without reopening streams. */
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
 * A task dispatch without a requested cwd runs in the task's worktree (dec_BBA713052997C3EF5F5D3DD952) on the node
 * that launches it, checked out and prepared here before the dispatch is published, as a start's is: a setup step
 * that fails refuses the dispatch (dec_8B3FCCD256CAC5B0BF3CCEDE58 CH3) while a long install never holds the
 * repository write queue. `bindingFor` is where the two kinds of node differ: this node's projection, or what the
 * center delivered to an edge (dec_57370FF2021DADF04E3B21724D CH2). A resumed dispatch keeps its own cwd; a
 * reviewer, a dry-run preview and anything else start at the repository root.
 */
export async function prepareDispatchWorktree(
  input: { readonly rootDir: string; readonly readSettings?: () => SettingsV1 },
  payload: {
    readonly cwd?: unknown;
    readonly role?: unknown;
    readonly dryRun?: unknown;
    readonly dispatchId?: unknown;
    readonly taskId?: unknown;
    readonly acceptedCommit?: string;
  },
  bindingFor: (taskId: string) => TaskWorktreeBindingV1 | null,
): Promise<TaskWorktreeCheckout | null> {
  const resumed = typeof payload.dispatchId === "string" ? readDispatchStream(input.rootDir, payload.dispatchId) : null,
    taskId = typeof payload.taskId === "string" ? payload.taskId : (resumed?.header.taskId ?? null),
    binding =
      payload.cwd === undefined &&
      !resumed?.header.cwd &&
      taskId &&
      payload.role !== "reviewer" &&
      payload.dryRun !== true
        ? bindingFor(taskId)
        : null;
  if (!taskId || !binding) {
    if (payload.acceptedCommit !== undefined)
      throw runtimeSpawnError(
        "runtime_handoff_workspace_missing",
        "The target task must have a managed worktree binding.",
      );
    return null;
  }
  const checkout = await checkoutTaskWorktree(
    input.rootDir,
    taskId,
    binding,
    input.readSettings?.().worktree.setup ?? [],
    payload.acceptedCommit,
  );
  if (checkout && !checkout.setup.ok)
    throw runtimeSpawnError(
      "worktree_setup_failed",
      worktreeSetupFailure(checkout.cwd, checkout.setup, `dispatch task ${taskId} again`, checkout.baseRef),
    );
  return checkout;
}

/** The binding source of a node that holds the ledger: the task as its own projection currently has it. */
export function projectedWorktreeBinding(input: {
  readonly projection?: () => TaskProjection;
}): (taskId: string) => TaskWorktreeBindingV1 | null {
  return (taskId) => {
    const projection = requiredRuntimeProjection(input);
    return openTaskWorktreeBinding(
      requireCurrentTaskProjection(projection, taskId, "runtime.run").snapshot.task,
      presetSnapshotReader(projection),
    );
  };
}

/** Where a dispatch runs: a resumed dispatch's own cwd, else its prepared task worktree, else the requested cwd. */
export function resolveDispatchCwd(
  rootDir: string,
  payload: { readonly cwd?: unknown },
  inherited: string | undefined,
  worktree: TaskWorktreeCheckout | null,
): { readonly cwd: string; readonly worktree: TaskWorktreeCheckout | null } {
  if (payload.cwd === undefined && inherited) return { cwd: inherited, worktree: null };
  return {
    cwd: resolveRuntimeCwd(
      rootDir,
      worktree
        ? { scope: "repo-relative", path: path.relative(rootDir, worktree.cwd) }
        : (payload.cwd ?? { scope: "repo-root" }),
    ),
    worktree,
  };
}

/** Bare native-session resumes must obey the same export boundary as dispatch resumes. */
export function assertNativeResumeNotExported(
  rootDir: string,
  providerSessionId: string,
  projection: TaskProjection,
): void {
  for (const session of projection.readRuntimeSessions()) {
    if (session.providerSessionId !== providerSessionId) continue;
    const dispatch = projection.readRuntimeDispatch(session.runtimeSessionId);
    if (dispatch && readHandoffCheckpoint(rootDir, dispatch.payload.dispatchId))
      throw runtimeSpawnError(
        "runtime_handoff_source_exported",
        "Use the target handoff claim for this exported native session.",
      );
  }
}

/** Select trusted checkpoint inheritance or ordinary local resume before assembling a launch. */
export function resolveRuntimeResume(
  input: import("./runtime-spawn-types.ts").RuntimeSpawnerInput,
  payload: import("./protocol/json-rpc-types.ts").JsonObject,
  handoff?: import("./runtime-handoff-store.ts").RuntimeHandoffCheckpoint,
) {
  const allowed = [
      "handoffEnabled",
      "runtimeInstanceId",
      "dispatchId",
      "agentId",
      "targetAgentId",
      "squadId",
      "squadRun",
      "role",
      "model",
      "effort",
      "fast",
      "permissionMode",
      "cwd",
      "prompt",
      "promptSource",
      "missionName",
      "onExitCommand",
      "taskId",
      "executionId",
      "reviewTarget",
      "idempotencyKey",
      "providerSessionId",
      "dryRun",
    ],
    unknownField = unknownFieldViolation(payload, allowed);
  if (unknownField)
    throw runtimeSpawnError("invalid_runtime_spawn", `Runtime spawn payload contains an ${unknownField}`);
  if (payload.squadRun !== undefined && !validSquadDispatchContext(payload.squadRun))
    throw runtimeSpawnError("invalid_runtime_spawn", "Runtime spawn squadRun must be a valid Squad dispatch context.");
  const requestedDispatchId =
      payload.dispatchId === undefined ? undefined : requiredRuntimeSpawnText(payload.dispatchId, "dispatchId"),
    resumed = handoff
      ? null
      : admitRuntimeResume(
          input.rootDir,
          requestedDispatchId,
          input.remote ? null : () => requiredRuntimeProjection(input),
        );
  const inherited = handoff
    ? {
        taskId: handoff.taskId,
        agentId: handoff.agentId,
        model: handoff.model,
        instanceId: undefined,
        permissionMode: undefined,
        cwd: undefined,
      }
    : resumed?.header;
  const handoffEnabled =
    handoff !== undefined || payload.handoffEnabled === true || resumed?.header.handoffEnabled === true;
  if (
    payload.handoffEnabled !== undefined &&
    (typeof payload.handoffEnabled !== "boolean" || requestedDispatchId || payload.providerSessionId !== undefined)
  )
    throw runtimeSpawnError("runtime_handoff_ineligible", "Opt in only when creating a new task-bound session.");
  return { requestedDispatchId, resumed, inherited, handoffEnabled };
}

/** Handoff opt-in and native version admission belong to the same resume boundary. */
export function assertRuntimeHandoffLaunch(
  enabled: boolean | undefined,
  checkpoint: import("./runtime-handoff-store.ts").RuntimeHandoffCheckpoint | undefined,
  launch: {
    taskId: string | null;
    agentId: string | undefined;
    role: string | undefined;
    trustedSchedule: import("./runtime-spawn-types.ts").TrustedScheduleRuntime | undefined;
  },
  kindId: string,
  version: string,
): void {
  if (
    enabled &&
    (!launch.taskId || kindId !== "codex" || !launch.agentId || launch.role === "reviewer" || launch.trustedSchedule)
  )
    throw runtimeSpawnError("runtime_handoff_ineligible", "Handoff is limited to task-bound Codex agent sessions.");
  if (checkpoint && !/^codex-cli 0\.159\.(?:1|3)$/u.test(version))
    throw runtimeSpawnError(
      "runtime_handoff_version_unsupported",
      "Target Codex version has not been verified for native handoff.",
    );
}
