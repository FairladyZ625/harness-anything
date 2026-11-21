import {
  isSha256Digest,
  resolveHarnessLayout,
  validSquadDispatchContext,
  verifyBareProviderSessionResumeIdentity,
  type PriorProviderSessionIdentity,
} from "@harness-anything/kernel";
import { daemonMethodPayloadFields } from "./protocol/daemon-protocol-commands.ts";
import { unknownFieldViolation } from "./protocol/json-rpc-types.ts";
import { readHandoffCheckpoint } from "./runtime-handoff-store.ts";
import { verifiedHandoffVersions } from "./runtime-handoff-native.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SettingsV1, TaskProjection, TaskWorktreeBindingV1 } from "@harness-anything/kernel";
import { resolveContainedPath } from "./contained-path.ts";
import {
  readDispatchStream,
  readDispatchStreamHeaders,
  readDispatchStreamSummary,
  type TrustedManagedCwdKind,
} from "./dispatch-stream.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "../runtime-engine/runtime-spawn-errors.ts";
import { resolveRuntimeCwd, resolveRuntimeInstanceCandidates } from "./runtime-spawn-mission.ts";
import { resolveRuntimeDispatchResources } from "./runtime-spawn-allowlist.ts";
import { requiredRuntimeProjection } from "./runtime-spawn-process.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RuntimeSpawnerInput } from "./runtime-spawn-types.ts";
import {
  checkoutTaskWorktree,
  openTaskWorktreeBinding,
  presetSnapshotReader,
  taskWorkspaceView,
  type TaskWorktreeCheckout,
} from "./task-worktree.ts";
import { noWorktreeSetup, worktreeSetupFailure } from "./worktree-setup.ts";
import { runtimeKindForId } from "../runtime-engine/runtime-inventory.ts";

export function admitRuntimeResume(
  rootDir: string,
  dispatchId: string | undefined,
  projection: (() => Pick<TaskProjection, "readRuntimeDispatchByResumeSource">) | null,
) {
  let resumed = dispatchId ? readDispatchStream(rootDir, dispatchId) : null;
  if (!dispatchId) return resumed;
  if (readHandoffCheckpoint(rootDir, dispatchId))
    throw runtimeSpawnError(
      "runtime_handoff_source_exported",
      "This dispatch was exported; use the target handoff claim action.",
    );
  // A taskless conversation dispatch that already has a resume child continues at the current
  // leaf: following the resumedFromDispatchId chain lets the caller keep naming the first
  // dispatch (the ask session id) while each round links to the round it continues. Task-bound
  // resumes keep the single-consumption contract: the source resumes once, later rounds name it.
  const leaf = resumed?.header.taskId == null ? resumeChainLeaf(dispatchId, projection) : dispatchId;
  if (leaf !== dispatchId) {
    if (readHandoffCheckpoint(rootDir, leaf))
      throw runtimeSpawnError(
        "runtime_handoff_source_exported",
        "This dispatch was exported; use the target handoff claim action.",
      );
    resumed = readDispatchStream(rootDir, leaf);
  }
  // On an edge the center checks consumption atomically when accepting the dispatch.
  const resumedDispatch = projection?.().readRuntimeDispatchByResumeSource(leaf);
  const admission = runtimeResumeAdmission({
    dispatchId: leaf,
    agentId: resumed?.header.agentId ?? null,
    kindId: resumed?.header.kindId ?? null,
    providerSessionId: resumed?.providerSessionId ?? null,
    resumedDispatches: resumedDispatchesBySource(resumedDispatch ? [resumedDispatch.event.payload] : []),
  });
  if (!admission.resumable && admission.reason === "missing_provider_session")
    throw runtimeSpawnError("runtime_dispatch_not_resumable", `Dispatch ${leaf} has no provider session to resume.`);
  if (!admission.resumable && admission.reason === "runtime_kind_unsupported")
    throw runtimeSpawnError(
      "runtime_dispatch_not_resumable",
      `Runtime ${admission.kindId} does not support provider-session resume.`,
    );
  if (!admission.resumable && admission.reason === "already_resumed")
    throw runtimeSpawnError(
      "runtime_dispatch_already_resumed",
      `Dispatch ${leaf} was already resumed as ${admission.resumedDispatchId}.`,
      {
        kind: "validation",
        entity: leaf,
        field: "dispatchId",
        actual: admission.resumedDispatchId,
        expectation:
          `Resume the existing dispatch ${admission.resumedDispatchId}; ` +
          "the source dispatch can only be resumed once.",
      },
    );
  return resumed;
}

/** The last dispatch of a resume chain, or the id itself when nothing resumed it yet. */
function resumeChainLeaf(
  dispatchId: string,
  projection: (() => Pick<TaskProjection, "readRuntimeDispatchByResumeSource">) | null,
): string {
  const seen = new Set<string>([dispatchId]);
  let current = dispatchId;
  for (;;) {
    const child = projection?.().readRuntimeDispatchByResumeSource(current)?.event.payload.dispatchId;
    if (!child || seen.has(child)) return current;
    seen.add(child);
    current = child;
  }
}

export type RuntimeResumeAdmission =
  | { readonly resumable: true; readonly dispatchId: string; readonly agentId: string | null }
  | { readonly resumable: false; readonly reason: "missing_provider_session" }
  | { readonly resumable: false; readonly reason: "runtime_kind_unsupported"; readonly kindId: string }
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
  readonly kindId?: string | null;
  readonly providerSessionId: string | null;
  readonly resumedDispatches: ReadonlyMap<string, string>;
}): RuntimeResumeAdmission {
  if (!input.providerSessionId) return { resumable: false, reason: "missing_provider_session" };
  if (
    input.kindId !== undefined &&
    input.kindId !== null &&
    runtimeKindForId(input.kindId).capabilities.resume !== "supported"
  )
    return { resumable: false, reason: "runtime_kind_unsupported", kindId: input.kindId };
  const resumedDispatchId = input.resumedDispatches.get(input.dispatchId);
  if (resumedDispatchId) return { resumable: false, reason: "already_resumed", resumedDispatchId };
  return { resumable: true, dispatchId: input.dispatchId, agentId: input.agentId };
}

/** A read-only attach reads the frozen round from the repository root so it never checks out or advances the task worktree. */
export function readOnlyAttachDispatch(input: RuntimeSpawnerInput, payload: JsonObject): boolean {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
  if (taskId === null || payload.role === "reviewer" || payload.dryRun === true) return false;
  const task = requireCurrentTaskProjection(requiredRuntimeProjection(input), taskId, "runtime.run").snapshot.task;
  if (task?.status !== "submitted" && task?.status !== "in_review") return false;
  const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
  return agentId !== undefined && input.resolveAgent !== undefined
    ? input.resolveAgent(agentId, task.metadata?.verticalId)?.permissionMode === "read-only"
    : false;
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
 * center delivered to an edge (dec_57370FF2021DADF04E3B21724D CH2). A resumed dispatch and a requested cwd keep
 * their own checkout; a dry-run preview and a task with no binding start at the repository root. A reviewer is
 * task-bound like an implementer here: relative writes from a review must land in its own checkout, never in the
 * canonical root the review is judging. A reviewer's checkout is pinned to the submission's frozen commit; submit
 * dispatches the review before the delivery order pushes that branch, so the published branch is not an anchor.
 * A task-bound dispatch never acquires the repository-root fallback when its required worktree cannot be cut:
 * an unborn repository is refused here before the provider launch, whether or not a start recorded an execution.
 * A start may record "no workspace on this node" without blocking its own lifecycle write; that answer does not
 * authorize a provider launch (issue #4431).
 */
export async function preflightRuntimeSelection(input: RuntimeSpawnerInput, payload: JsonObject): Promise<void> {
  // A resumed dispatch carries its own model and instance in the recorded stream header; do not
  // re-resolve it from the current declaration before the resume admission reads that header.
  if (typeof payload.dispatchId === "string" || typeof payload.providerSessionId === "string") return;
  const runtimeInstanceId =
      typeof payload.runtimeInstanceId === "string"
        ? requiredRuntimeSpawnText(payload.runtimeInstanceId, "runtimeInstanceId")
        : undefined,
    agentId =
      typeof payload.agentId === "string" && payload.squadId === undefined && payload.targetAgentId === undefined
        ? payload.agentId
        : undefined,
    taskId = typeof payload.taskId === "string" ? payload.taskId : null,
    verticalId =
      agentId !== undefined && input.resolveAgent !== undefined && taskId !== null && !input.remote && input.projection
        ? requireCurrentTaskProjection(requiredRuntimeProjection(input), taskId, "runtime.run").snapshot.task?.metadata
            ?.verticalId
        : undefined,
    agent = agentId === undefined ? null : (input.resolveAgent?.(agentId, verticalId) ?? null),
    requested = runtimeInstanceId ?? agent?.instance;
  if (requested === undefined) return;
  const projection = input.remote ? null : requiredRuntimeProjection(input),
    [sessions, instances, allowedInstanceIds, health] = await resolveRuntimeDispatchResources(
      input,
      input.remote,
      projection,
    );
  resolveRuntimeInstanceCandidates({
    ...(requested === undefined ? {} : { requested }),
    ...(runtimeInstanceId === undefined ? {} : { explicitlyRequested: true }),
    ...(typeof payload.providerSessionId === "string" ? { providerSessionId: payload.providerSessionId } : {}),
    agent,
    ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    ...(typeof payload.runtimeKind === "string" ? { runtimeKind: payload.runtimeKind } : {}),
    instances,
    allowedInstanceIds,
    sessions,
    health,
    now: input.now(),
  });
}

export async function prepareDispatchWorktree(
  input: {
    readonly rootDir: string;
    readonly readSettings?: () => SettingsV1;
    readonly remote?: import("./runtime-spawn-types.ts").RemoteRuntimePersistence;
    readonly projection?: () => TaskProjection;
  },
  payload: {
    readonly cwd?: unknown;
    readonly role?: unknown;
    readonly dryRun?: unknown;
    readonly dispatchId?: unknown;
    readonly taskId?: unknown;
    readonly acceptedCommit?: string;
  },
  bindingFor: (taskId: string) => TaskWorktreeBindingV1 | null,
  pinnedCommit?: string | null,
): Promise<TaskWorktreeCheckout | null> {
  const resumed = typeof payload.dispatchId === "string" ? readDispatchStream(input.rootDir, payload.dispatchId) : null,
    taskId = typeof payload.taskId === "string" ? payload.taskId : (resumed?.header.taskId ?? null),
    binding =
      payload.cwd === undefined && !resumed?.header.cwd && taskId && payload.dryRun !== true
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
  if (payload.role === "reviewer" && pinnedCommit === undefined)
    throw runtimeSpawnError(
      "review_target_missing",
      `Reviewer dispatch for task ${taskId} has no resolved submitted cut to check out.`,
    );
  const checkout = await checkoutTaskWorktree(
    input.rootDir,
    taskId,
    binding,
    input.readSettings?.().worktree ?? noWorktreeSetup(),
    payload.acceptedCommit,
    undefined,
    {
      readDispatchLifecycle: (query) =>
        input.remote ? input.remote.readDispatchLifecycle(query) : input.projection!().readDispatchLifecycle(query),
      ...(payload.role === "reviewer"
        ? pinnedCommit === null
          ? { followPublishedBranch: false }
          : { pinnedCommit }
        : {}),
    },
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

/** Artifact tasks stay in their package, including resumes of dispatches launched before that boundary. */
export function dispatchTaskPackageRoot(
  input: RuntimeSpawnerInput,
  taskId: string | null,
  remoteTask: { readonly worktree: TaskWorktreeBindingV1 | null; readonly packageRoot: string } | null,
): string | null {
  if (!taskId) return null;
  if (remoteTask) return remoteTask.worktree ? null : remoteTask.packageRoot;
  const projection = requiredRuntimeProjection(input),
    read = requireCurrentTaskProjection(projection, taskId, "runtime.run"),
    workspace = taskWorkspaceView(
      input.rootDir,
      read.snapshot.task,
      read.packagePath,
      presetSnapshotReader(projection),
      resolveHarnessLayout(input.rootDir).authoredRoot,
    );
  return workspace?.kind === "task-package" ? path.resolve(input.rootDir, workspace.path) : null;
}

/** Managed decision review package root when the dispatch targets that decision's own directory. */
export function dispatchDecisionPackageRoot(
  rootDir: string,
  payload: JsonObject,
  decisionReviewTarget: { readonly decisionId: string } | null,
): string | null {
  if (decisionReviewTarget === null) return null;
  const packageRoot = path.join(
    resolveHarnessLayout(rootDir).decisionsRoot,
    `decision-${decisionReviewTarget.decisionId}`,
  );
  if (!existsSync(packageRoot)) return null;
  if (payload.cwd === undefined) return packageRoot;
  if (
    typeof payload.cwd === "object" &&
    payload.cwd !== null &&
    !Array.isArray(payload.cwd) &&
    (payload.cwd as Record<string, unknown>).scope === "repo-relative" &&
    typeof (payload.cwd as Record<string, unknown>).path === "string" &&
    path.resolve(rootDir, (payload.cwd as Record<string, unknown>).path as string) === packageRoot
  )
    return packageRoot;
  return null;
}

/** Managed containment roots authorized strictly by trusted system-materialized cwd provenance. */
export function managedRootsForTrustedCwd(
  rootDir: string,
  trustedManagedCwd?: TrustedManagedCwdKind,
): readonly string[] {
  if (trustedManagedCwd === "worktree") return [path.join(rootDir, ".worktrees")];
  if (trustedManagedCwd === "task-package" || trustedManagedCwd === "decision-package")
    return [resolveHarnessLayout(rootDir).authoredRoot];
  return [];
}

/** Validate a system-materialized directory against the repository root or its declared managed roots. */
function resolveManagedDispatchCwd(rootDir: string, target: string, managedRoots: readonly string[]): string {
  if (!existsSync(target)) throw runtimeSpawnError("invalid_runtime_cwd", "Runtime cwd directory does not exist.");
  const directRelative = path.relative(rootDir, target);
  const direct = resolveContainedPath(rootDir, directRelative === "" ? "." : directRelative);
  if (direct !== null) return direct;
  for (const managedRoot of managedRoots) {
    if (!existsSync(managedRoot)) continue;
    const managedRelative = path.relative(managedRoot, target);
    const contained = resolveContainedPath(managedRoot, managedRelative === "" ? "." : managedRelative);
    if (contained !== null) return contained;
  }
  throw runtimeSpawnError("invalid_runtime_cwd", "Runtime cwd must stay inside the repository.");
}

/** A package boundary takes precedence over both caller overrides and inherited cwd. */
export function resolveDispatchCwd(
  rootDir: string,
  payload: { readonly cwd?: unknown },
  inherited: string | undefined,
  worktree: TaskWorktreeCheckout | null,
  taskPackageRoot?: string | null,
  inheritedManagedRoots: readonly string[] = [],
): { readonly cwd: string; readonly worktree: TaskWorktreeCheckout | null } {
  if (taskPackageRoot) {
    return {
      cwd: resolveManagedDispatchCwd(rootDir, taskPackageRoot, [resolveHarnessLayout(rootDir).authoredRoot]),
      worktree: null,
    };
  }
  if (payload.cwd === undefined && inherited) {
    return {
      cwd: resolveManagedDispatchCwd(rootDir, inherited, inheritedManagedRoots),
      worktree: null,
    };
  }
  return {
    cwd: worktree
      ? resolveManagedDispatchCwd(rootDir, worktree.cwd, [path.join(rootDir, ".worktrees")])
      : resolveRuntimeCwd(rootDir, payload.cwd ?? { scope: "repo-root" }),
    worktree,
  };
}

/** Bare native-session resumes must obey the same export boundary as dispatch resumes. */
export function assertNativeResumeNotExported(
  rootDir: string,
  providerSessionId: string,
  projection: TaskProjection,
): void {
  for (const session of projection.readRuntimeSessions({ providerSessionId })) {
    const dispatch = projection.readRuntimeDispatch(session.runtimeSessionId);
    if (dispatch && readHandoffCheckpoint(rootDir, dispatch.payload.dispatchId))
      throw runtimeSpawnError(
        "runtime_handoff_source_exported",
        "Use the target handoff claim for this exported native session.",
      );
  }
}

const runtimeSpawnInternalFields = Object.freeze([
  "arrangementId",
  "squadRun",
  "executionId",
  "preferredRuntimeInstanceId",
  "preferredModel",
  "avoidVendor",
]);

/** Select trusted checkpoint inheritance or ordinary local resume before assembling a launch. */
export function resolveRuntimeResume(
  input: import("./runtime-spawn-types.ts").RuntimeSpawnerInput,
  payload: import("./protocol/json-rpc-types.ts").JsonObject,
  handoff?: import("./runtime-handoff-store.ts").RuntimeHandoffCheckpoint,
) {
  const allowed = [
      ...new Set([...daemonMethodPayloadFields("repo.agentRuntime.spawn"), ...runtimeSpawnInternalFields]),
    ],
    unknownField = unknownFieldViolation(payload, allowed);
  if (unknownField)
    throw runtimeSpawnError("invalid_runtime_spawn", `Runtime spawn payload contains an ${unknownField}`);
  if (payload.squadRun !== undefined && !validSquadDispatchContext(payload.squadRun))
    throw runtimeSpawnError("invalid_runtime_spawn", "Runtime spawn squadRun must be a valid Squad dispatch context.");
  if (payload.providerSessionId !== undefined && (payload.dispatchId !== undefined || handoff !== undefined))
    throw runtimeSpawnError("invalid_runtime_spawn", "Choose one runtime resume source.");
  const requestedDispatchId =
      payload.dispatchId === undefined ? undefined : requiredRuntimeSpawnText(payload.dispatchId, "dispatchId"),
    resumed = handoff
      ? null
      : admitRuntimeResume(
          input.rootDir,
          requestedDispatchId,
          input.remote ? null : () => requiredRuntimeProjection(input),
        ),
    // admitRuntimeResume follows a resume chain to its current leaf, so the recorded
    // resumedFromDispatchId names the round the new dispatch actually continues — the chain
    // stays linear even when the caller keeps passing the first dispatch of the conversation.
    effectiveResumeSourceId = resumed?.header.dispatchId ?? requestedDispatchId;
  const inherited = handoff
    ? {
        taskId: handoff.taskId,
        agentId: handoff.agentId,
        model: handoff.model,
        instanceId: undefined,
        permissionMode: undefined,
        mcpPolicy: undefined,
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
  return { requestedDispatchId: effectiveResumeSourceId, resumed, inherited, handoffEnabled };
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
  if (checkpoint && !verifiedHandoffVersions.some((verified) => version === `codex-cli ${verified}`))
    throw runtimeSpawnError(
      "runtime_handoff_version_unsupported",
      "Target Codex version has not been verified for native handoff.",
    );
}

export function parseDispatchSnapshotExpectations(payload: JsonObject): {
  readonly expectedAgentDeclarationDigest?: string;
  readonly expectedSkillSnapshotDigest?: string;
} {
  const expectedAgentDeclarationDigest =
      payload.expectedAgentDeclarationDigest === undefined
        ? undefined
        : requiredRuntimeSpawnText(payload.expectedAgentDeclarationDigest, "expectedAgentDeclarationDigest"),
    expectedSkillSnapshotDigest =
      payload.expectedSkillSnapshotDigest === undefined
        ? undefined
        : requiredRuntimeSpawnText(payload.expectedSkillSnapshotDigest, "expectedSkillSnapshotDigest");
  if (expectedAgentDeclarationDigest !== undefined && !isSha256Digest(expectedAgentDeclarationDigest))
    throw runtimeSpawnError("invalid_runtime_spawn", "expectedAgentDeclarationDigest must be a sha256:<64hex> digest.");
  if (expectedSkillSnapshotDigest !== undefined && !isSha256Digest(expectedSkillSnapshotDigest))
    throw runtimeSpawnError("invalid_runtime_spawn", "expectedSkillSnapshotDigest must be a sha256:<64hex> digest.");
  return {
    ...(expectedAgentDeclarationDigest !== undefined ? { expectedAgentDeclarationDigest } : {}),
    ...(expectedSkillSnapshotDigest !== undefined ? { expectedSkillSnapshotDigest } : {}),
  };
}

/**
 * Resolves the canonical (or local-spool) prior session identities bound to `providerSessionId`
 * and enforces Agent, Skill snapshot, owner, and task continuity before any bare resume launch.
 */
export async function assertBareProviderSessionResumeIdentity(request: {
  readonly input: RuntimeSpawnerInput;
  readonly projection: TaskProjection | null;
  readonly providerSessionId: string;
  readonly personId: string;
  readonly taskId: string | null;
  readonly agentId: string | null;
  readonly agentDeclarationDigest: string | null;
  readonly skillSnapshotDigest: string | null;
}): Promise<void> {
  const { input, projection, providerSessionId } = request;
  if (!input.remote && projection) assertNativeResumeNotExported(input.rootDir, providerSessionId, projection);
  const priorIdentities: PriorProviderSessionIdentity[] = [];
  if (input.remote) {
    const sessions = await input.remote.readRuntimeSessions({ providerSessionId });
    for (const session of sessions) {
      const dispatch = await input.remote.readRuntimeDispatch(session.runtimeSessionId);
      if (!dispatch) continue;
      priorIdentities.push({
        runtimeSessionId: session.runtimeSessionId,
        personId: dispatch.actor.principal.personId,
        taskId: dispatch.payload.taskId ?? null,
        agentId: dispatch.payload.agentId ?? null,
        ...(dispatch.payload.agentDeclarationDigest !== undefined
          ? { agentDeclarationDigest: dispatch.payload.agentDeclarationDigest }
          : {}),
        ...(dispatch.payload.skillSnapshotDigest !== undefined
          ? { skillSnapshotDigest: dispatch.payload.skillSnapshotDigest }
          : {}),
      });
    }
  } else if (projection) {
    for (const session of projection.readRuntimeSessions({ providerSessionId })) {
      const dispatch =
        projection.readRuntimeDispatch(session.runtimeSessionId, session.definitionSnapshotRef) ??
        projection.readLatestRuntimeDispatchBySession(session.runtimeSessionId);
      if (!dispatch) continue;
      priorIdentities.push({
        runtimeSessionId: session.runtimeSessionId,
        personId: dispatch.actor.principal.personId,
        taskId: dispatch.payload.taskId ?? null,
        agentId: dispatch.payload.agentId ?? null,
        ...(dispatch.payload.agentDeclarationDigest !== undefined
          ? { agentDeclarationDigest: dispatch.payload.agentDeclarationDigest }
          : {}),
        ...(dispatch.payload.skillSnapshotDigest !== undefined
          ? { skillSnapshotDigest: dispatch.payload.skillSnapshotDigest }
          : {}),
      });
    }
  }
  if (priorIdentities.length === 0) {
    for (const header of readDispatchStreamHeaders(input.rootDir, true)) {
      if (!header.binding) continue;
      if (readDispatchStreamSummary(input.rootDir, header.dispatchId)?.providerSessionId !== providerSessionId)
        continue;
      priorIdentities.push({
        runtimeSessionId: header.runtimeSessionId,
        personId: header.binding.actor.principal.personId,
        taskId: header.taskId ?? null,
        agentId: header.agentId ?? null,
        ...(header.agentDeclarationDigest !== undefined
          ? { agentDeclarationDigest: header.agentDeclarationDigest }
          : {}),
        ...(header.skillSnapshotDigest !== undefined ? { skillSnapshotDigest: header.skillSnapshotDigest } : {}),
      });
    }
  }
  const verdict = verifyBareProviderSessionResumeIdentity(priorIdentities, {
    providerSessionId,
    personId: request.personId,
    taskId: request.taskId,
    agentId: request.agentId,
    agentDeclarationDigest: request.agentDeclarationDigest,
    skillSnapshotDigest: request.skillSnapshotDigest,
  });
  if (!verdict.ok) throw runtimeSpawnError(verdict.code, verdict.message);
}
