import type { GitHistoryPort } from "@harness-anything/application/internal/queries/file-trace-read.ts";
import { openCloudRuntime } from "./runtime-cloud-target.ts";
import { collectRuntimeWorkspaceProgress, type RuntimeWorkspaceProgress } from "./runtime-continuation-context.ts";
import { prepareRuntimeCausalGitHistory } from "./repo-cell-trace-view.ts";
import { readDispatchStageClock } from "./dispatch-stage-clock.ts";
import {
  currentExecutionArrangement,
  executionArrangementAllows,
} from "@harness-anything/kernel/internal/domain/task-execution-arrangement.ts";
import type { SquadDispatchContext } from "@harness-anything/kernel";
import {
  DEFAULT_RUNTIME_STALL_TIMEOUT_MS,
  computeAgentDeclarationDigest,
  dispatchOwnerForNode,
  dispatchAdmissionBlocker,
  sha256Text,
  verifyDispatchSnapshotFence,
} from "@harness-anything/kernel";
import type { RuntimeHandoffCheckpoint } from "./runtime-handoff-store.ts";
import { readDispatchLifecycle, readyDispatchLifecycle } from "./runtime-dispatch-admission.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CanonicalEventStore } from "@harness-anything/kernel";
import {
  clampPermissionMode,
  resolveScheduledPermissionMode,
  runtimeDefinitionSnapshotArtifact,
  runtimeSessionIdFromActor,
  submissionDigest,
  validRuntimeLaunchPermissionMode,
  type AuthorizationDecision,
  type RuntimePermissionModeSource,
} from "@harness-anything/kernel";
import {
  agentRuntimeModelMatches,
  agentRuntimeModelSpelling,
  agentRuntimeTargetForKind,
} from "./agent-runtime-contract.ts";
import { selectedRuntimeInstance, createRuntimeInstanceDispatchState } from "./runtime-instance-selection.ts";
import { resolveDispatchAgent } from "./runtime-spawn-agent.ts";
import { assertAgentDispatchable } from "./agent-entities.ts";
import { sharedProviderDirectory } from "./agent-runtime-instance-storage.ts";
import {
  openDispatchStream,
  readDispatchStream,
  removeDispatchStream,
  scrubProviderValue,
  type DispatchStreamWriter,
  type TrustedManagedCwdKind,
} from "./dispatch-stream.ts";
import { type JsonObject } from "./protocol/json-rpc-types.ts";
import { runtimeKindForId } from "../runtime-engine/runtime-inventory.ts";
import { resolveRuntimeDispatchResources } from "./runtime-spawn-allowlist.ts";
import {
  resolveRuntimeMcpPolicy,
  runtimeMcpPolicy,
  runtimePermissionMode,
  runtimeSupportsMcpPolicy,
} from "../runtime-engine/runtime-permissions.ts";
import { dispatchCallbackRelay, removeRuntimeCallbackRelay } from "./runtime-callback-relay.ts";
import { cancelRuntime, closeRuntimes, enforceRuntimeSpendCap, steerRuntime } from "./runtime-spawn-control.ts";
import { createActiveRuntime, attachActiveRuntime } from "./runtime-spawn-active.ts";
import {
  adoptRuntimes,
  reclaimFailedLaunchTempDirectory,
  sweepSettledRuntimeTempDirectories,
} from "./runtime-spawn-adoption.ts";
import {
  requiredRuntimeSpawnText,
  runtimeErrorCode,
  runtimeErrorMessage,
  runtimeSpawnError,
  runtimeTaskExecutionFrozenError,
  runtimeTaskLeaseRequiredMessage,
} from "../runtime-engine/runtime-spawn-errors.ts";
import {
  assembleAgentPrompt,
  assembleUnboundPrompt,
  assembleScheduledMission,
  assembleTaskMission,
  dispatchMissionForPermission,
  decisionReviewTarget as parseDecisionReviewTarget,
  prepareRuntimeInstance,
  resolveRuntimeInstanceCandidates,
  runtimeMissionName,
  resolveRuntimeMission,
  selfIterationCloseoutSection,
} from "./runtime-spawn-mission.ts";
import {
  dispatchLedgerReadTexts,
  privateLedgerReadSection,
  resolvePrivateLedgerReads,
} from "./private-ledger-paths.ts";
import { dispatchPromptTemplate, renderDispatchPrompt } from "./runtime-spawn-prompt.ts";
import {
  assertPreparedRuntimeLaunch,
  launchExitNotification,
  launchNative,
  launchRuntimeProcess,
  isRuntimeProcessStartRejected,
  requiredRuntimeProjection,
  requiredRuntimeStore,
} from "./runtime-spawn-process.ts";
import { isStructuredSuccessResult, parseProviderFrame } from "./runtime-spawn-provider-frames.ts";
import { publishRuntimeEvent as publishRuntimeEventImpl } from "./runtime-spawn-provider-stream.ts";
import { runtimeProcessTreeStopped } from "./runtime-spawn-settlement.ts";
import * as runtimeSpawnerDelegates from "./runtime-spawner-delegates.ts";
import { runtimeBindingForDispatch } from "./runtime-spawn-types.ts";
import { readActiveDispatchLifecycle } from "./runtime-dispatch-admission.ts";
import { configureWorkerGitIdentity } from "./runtime-worker-push.ts";
import type {
  ActiveRuntime,
  ResumeProcessObservation,
  RuntimeBinding,
  RuntimeSpawnerInput,
  RuntimeExecutionHandle,
  TrustedScheduleRuntime,
  TrustedScheduleSpawn,
} from "./runtime-spawn-types.ts";
import type { RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { runtimeDispatchRequestedPayload } from "../runtime-engine/runtime-spawn-event.ts";
import { daemonCliBinDirectory, prepareBoundRuntimeLaunch } from "./runtime-spawn-context.ts";
import type { RuntimeEventOf, RuntimeEventType, RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { runtimeExecutionRoleForLaunch, taskExecutionSurfaces } from "./runtime-execution-scope.ts";
import {
  assertReviewerTarget,
  parseTaskReviewTarget,
  reviewerPinnedCommit,
  selectReadOnlyAttachTarget,
  selectReviewTarget,
} from "./review-dispatch-admission.ts";
import { assertContextBudget, ModelSlotQueue } from "./runtime/model-slot-queue.ts";
import { relayBudgetMicrosOf } from "./runtime/cloud-dispatch-relay.ts";
import {
  initialFallbackAttempt,
  releaseFallbackResources,
  settleFallbackAttempt,
  settleStartRejectedAttempt,
  scheduleFallbackContinuation,
  requiredRuntimeFast,
} from "./runtime-spawn-fallback.ts";
import {
  resolveRuntimeResume,
  assertBareProviderSessionResumeIdentity,
  assertNativeResumeNotExported,
  assertRuntimeHandoffLaunch,
  assertResumeAgent,
  parseDispatchSnapshotExpectations,
  readOnlyAttachDispatch,
  ensureFallbackReviewWorktree,
  prepareDispatchWorktree,
  preflightRuntimeSelection,
  projectedWorktreeBinding,
  resolveDispatchCwd,
  dispatchDecisionPackageRoot,
  dispatchTaskPackageRoot,
  managedRootsForTrustedCwd,
} from "./runtime-resume-admission.ts";
import {
  materializeDispatchSkillSnapshot,
  prepareDispatchSkillSnapshot,
  reclaimSessionSkillSnapshot,
} from "./agent-skill-snapshot.ts";
import { installHandoffRollout } from "./runtime-handoff-native.ts";
import {
  reclaimReviewWorktree,
  resolveManagedReviewWorktreePath,
  taskWorktreeCheckoutNote,
  verifyHandoffWorktree,
  verifyReviewCheckout,
  type TaskWorktreeCheckout,
} from "./task-worktree.ts";
import { requireTaskWriterAdmission } from "./runtime-dispatch-admission.ts";
import * as taskDispatchAdmission from "./task-dispatch-admission.ts";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { admitTaskDispatch, runtimeDispatchIdentity } from "./task-dispatch-recovery.ts";
import { runtimeSpawnReceipt } from "../runtime-engine/runtime-spawn-receipt.ts";
export const resultMediaType = "text/plain; charset=utf-8" as const;
const { providerErrorLimit } = daemonRuntimePolicy.defaultValue.process;
// Captured at module level: spawnAttempt's local `process` names the launched RuntimeProcess.
const hostPlatform = process.platform;
type RuntimeTaskClaimScope = { release?: () => Promise<void> };
interface SpawnAttemptOptions {
  readonly inheritedFallback?: RuntimeFallbackAttempt;
  readonly trustedSchedule?: TrustedScheduleRuntime;
  readonly handoffFromRuntimeSessionId?: string;
  readonly publicationOwner?: ActiveRuntime["publicationOwner"];
  readonly preparedWorktree?: TaskWorktreeCheckout | null;
  readonly handoff?: RuntimeHandoffCheckpoint;
  readonly handoffRollout?: Uint8Array;
  readonly onDispatched?: (dispatchId: string, runtimeSessionId: string) => void;
  readonly onPrepared?: (dispatchId: string, runtimeSessionId: string) => void;
  readonly admissionTaskRead?: ReturnType<typeof requireCurrentTaskProjection> | null;
  readonly workspaceProgress?: RuntimeWorkspaceProgress;
  readonly causalGitHistory?: GitHistoryPort | null;
  readonly recoveryRequested?: boolean;
  readonly inheritedFallbackCwd?: string;
  readonly trustedManagedCwd?: TrustedManagedCwdKind;
}

function releaseFailedTaskClaim<Args extends unknown[]>(
  spawn: (claim: RuntimeTaskClaimScope, ...args: Args) => Promise<JsonObject>,
): (...args: Args) => Promise<JsonObject> {
  return async (...args) => {
    const claim: RuntimeTaskClaimScope = {};
    try {
      return await spawn(claim, ...args);
    } catch (error) {
      try {
        await claim.release?.();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], "Runtime spawn and task claim release both failed.");
      }
      throw error;
    }
  };
}

export function makeRuntimeSpawner(input: RuntimeSpawnerInput) {
  const dispatchState = input.runtimeInstanceDispatchState ?? createRuntimeInstanceDispatchState();
  const activeRuntimeHandles = new Map<string, ActiveRuntime>(),
    exiting = new Set<string>(),
    queuedSteerInFlight = new Set<string>(),
    launch = input.launch ?? launchNative,
    prepareDaemonGitEnvironment = (instanceId: string, provider: "github" | "gitlab" = "github") =>
      input.prepareDaemonGitEnvironment?.(instanceId, provider, input.repoId).then((value) => value ?? undefined) ??
      Promise.resolve(undefined);
  const modelSlotQueue =
    input.modelSlotQueue ??
    new ModelSlotQueue({
      globalCapacity: daemonRuntimePolicy.defaultValue.runtime.modelSlots.globalCapacity,
      perOwnerCapacity: daemonRuntimePolicy.defaultValue.runtime.modelSlots.perOwnerCapacity,
    });
  const ownsModelSlotQueue = input.modelSlotQueue === undefined;
  let fallbackClosed = false;
  const fallbackAbort = new AbortController();
  const spawnAttempt = releaseFailedTaskClaim(spawnClaimAttempt);
  const extracted: RuntimeSpawnerContext = {
    dispatchState,
    closed: () => fallbackClosed,
    closeSignal: fallbackAbort.signal,
    input,
    requiredRuntimeStore,
    requiredRuntimeProjection,
    runtimeSpawnError,
    consumeChunk: (active, chunk, flush, persisted) =>
      runtimeSpawnerDelegates.consumeChunk(extracted, active, chunk, flush, persisted),
    consumeLine: (active, line, persisted, publishSignals) =>
      runtimeSpawnerDelegates.consumeLine(extracted, active, line, persisted, publishSignals),
    markProtocolError: (active) => runtimeSpawnerDelegates.markProtocolError(extracted, active),
    parseProviderFrame,
    bindProvider: (active, identity) => runtimeSpawnerDelegates.bindProvider(extracted, active, identity),
    isStructuredSuccessResult,
    processes: activeRuntimeHandles,
    ownsModelSlot: (runtimeSessionId) => modelSlotQueue.position(runtimeSessionId) === 0,
    providerErrorLimit,
    publishRuntimeEvent,
    exiting,
    queuedSteerInFlight,
    spawnQueuedSteerTurn: async (payload, binding, options) => {
      const preparedWorktree =
        options?.preparedWorktree ??
        (!input.remote ? await prepareDispatchWorktree(input, payload, projectedWorktreeBinding(input)) : null);
      return spawnAttempt(payload, binding, {
        preparedWorktree,
        recoveryRequested: options?.recoveryRequested === true,
      });
    },
    runtimeResultText: (active, code, outcome) =>
      runtimeSpawnerDelegates.runtimeResultText(extracted, active, code, outcome),
    resultMediaType,
    launchExitNotification,
    publishExit: (active, code, resumePublishedExit) =>
      runtimeSpawnerDelegates.publishExit(extracted, active, code, resumePublishedExit),
    enforceSpendCap: (active) => enforceRuntimeSpendCap(extracted, active),
    controlReceipt: (opId, runtimeSessionId, detail, settlementReceipt) =>
      runtimeSpawnerDelegates.controlReceipt(extracted, opId, runtimeSessionId, detail, settlementReceipt),
    captureErrorOutput: (active, chunk) => runtimeSpawnerDelegates.captureErrorOutput(extracted, active, chunk),
    prepareDaemonGitEnvironment,
    settleFallback: (active, outcome, terminal) => settleFallbackAttempt(extracted, active, outcome, terminal),
    reconcileFallback: (dispatchId) =>
      scheduleFallbackContinuation({
        context: extracted,
        ensureFallbackWorktree: (params) => ensureFallbackReviewWorktree(input, params, reviewerPinnedCommit),
        prepareCausalGitHistory: (taskId) =>
          prepareRuntimeCausalGitHistory({
            rootDir: input.rootDir,
            payload: { taskId },
            projection: input.projection,
            remote: input.remote,
            runGitHistoryAsync: input.runGitHistoryAsync,
          }),
        launch: (
          payload,
          binding,
          fallback,
          schedule,
          handoffFromRuntimeSessionId,
          publicationOwner,
          onDispatched,
          workspaceProgress,
          inheritedCwd,
          preparedWorktree,
          trustedManagedCwd,
          causalGitHistory,
        ) =>
          spawnAttempt(payload, binding, {
            inheritedFallback: fallback,
            trustedSchedule: schedule,
            handoffFromRuntimeSessionId,
            publicationOwner,
            preparedWorktree: preparedWorktree ?? null,
            onDispatched,
            workspaceProgress,
            causalGitHistory,
            inheritedFallbackCwd: inheritedCwd,
            trustedManagedCwd,
          }),
        dispatchId,
      }),
    ...(input.onPendingSteerReceipt ? { triggerSteerReceiptFlush: input.onPendingSteerReceipt } : {}),
  };
  async function spawnClaimAttempt(
    claim: RuntimeTaskClaimScope,
    payload: JsonObject,
    binding: RuntimeBinding,
    options: SpawnAttemptOptions = {},
  ): Promise<JsonObject> {
    const {
      inheritedFallback,
      trustedSchedule,
      handoffFromRuntimeSessionId,
      publicationOwner = "runtime",
      preparedWorktree = null,
      handoff,
      handoffRollout,
      onDispatched,
      onPrepared,
      admissionTaskRead,
      workspaceProgress,
      causalGitHistory,
      recoveryRequested = false,
      inheritedFallbackCwd,
      trustedManagedCwd,
    } = options;
    const dryRun = payload.dryRun === true,
      dispatchUsageLimit = input.readSettings?.().runtime.dispatchUsageLimit ?? 0;
    const { requestedDispatchId, resumed, inherited, handoffEnabled } = resolveRuntimeResume(input, payload, handoff);
    const explicitRuntimeInstanceId =
        payload.runtimeInstanceId === undefined
          ? inherited?.instanceId
          : requiredRuntimeSpawnText(payload.runtimeInstanceId, "runtimeInstanceId"),
      explicitMission = payload.prompt === undefined ? undefined : requiredRuntimeSpawnText(payload.prompt, "prompt"),
      missionName = payload.missionName === undefined ? undefined : runtimeMissionName(payload.missionName),
      agentId =
        payload.agentId === undefined ? inherited?.agentId : requiredRuntimeSpawnText(payload.agentId, "agentId"),
      targetAgentId =
        payload.targetAgentId === undefined
          ? undefined
          : requiredRuntimeSpawnText(payload.targetAgentId, "targetAgentId"),
      squadId = payload.squadId === undefined ? undefined : requiredRuntimeSpawnText(payload.squadId, "squadId"),
      role = payload.role === undefined ? undefined : requiredRuntimeSpawnText(payload.role, "role"),
      // Delegation provenance: which already-running runtime session invoked this spawn.
      parentRuntimeSessionId = runtimeSessionIdFromActor(binding.actor),
      model = payload.model === undefined ? inherited?.model : requiredRuntimeSpawnText(payload.model, "model"),
      preferredRuntimeInstanceId =
        payload.preferredRuntimeInstanceId === undefined
          ? undefined
          : requiredRuntimeSpawnText(payload.preferredRuntimeInstanceId, "preferredRuntimeInstanceId"),
      preferredModel =
        payload.preferredModel === undefined
          ? undefined
          : requiredRuntimeSpawnText(payload.preferredModel, "preferredModel"),
      avoidVendor =
        payload.avoidVendor === undefined ? undefined : requiredRuntimeSpawnText(payload.avoidVendor, "avoidVendor"),
      effort = payload.effort === undefined ? undefined : requiredRuntimeSpawnText(payload.effort, "effort"),
      fast = payload.fast === undefined ? undefined : requiredRuntimeFast(payload.fast),
      permissionMode =
        payload.permissionMode === undefined
          ? (inherited?.permissionMode ?? undefined)
          : requiredRuntimeSpawnText(payload.permissionMode, "permissionMode"),
      mcpPolicy =
        payload.mcpPolicy === undefined
          ? (inherited?.mcpPolicy ?? undefined)
          : requiredRuntimeSpawnText(payload.mcpPolicy, "mcpPolicy"),
      promptSource =
        payload.promptSource === undefined ? undefined : requiredRuntimeSpawnText(payload.promptSource, "promptSource"),
      onExitCommand =
        payload.onExitCommand === undefined
          ? undefined
          : requiredRuntimeSpawnText(payload.onExitCommand, "onExitCommand"),
      dispatchKey = requiredRuntimeSpawnText(payload.dispatchKey, "dispatchKey"),
      taskId =
        payload.taskId === null || payload.taskId === undefined
          ? (inherited?.taskId ?? null)
          : requiredRuntimeSpawnText(payload.taskId, "taskId"),
      requestedExecutionId =
        payload.executionId === undefined ? undefined : requiredRuntimeSpawnText(payload.executionId, "executionId"),
      decisionReviewTarget = parseDecisionReviewTarget(payload.reviewTarget),
      taskReviewTarget = parseTaskReviewTarget(payload.reviewTarget),
      providerSessionId =
        typeof payload.providerSessionId === "string"
          ? requiredRuntimeSpawnText(payload.providerSessionId, "providerSessionId")
          : (handoff?.providerSessionId ?? resumed?.providerSessionId);
    assertResumeAgent(requestedDispatchId, inherited?.agentId, payload.agentId, agentId);
    if (!taskId && requestedExecutionId !== undefined)
      throw runtimeSpawnError(
        "runtime_execution_binding_forbidden",
        "An unbound runtime run cannot attach to an Execution; use ha agent run with --task.",
      );
    if (missionName && !taskId)
      throw runtimeSpawnError("invalid_runtime_mission", "Use --mission <name> only with --task <task-id>.");
    if (missionName && explicitMission)
      throw runtimeSpawnError("invalid_runtime_mission", "Use --mission <name> or --prompt <text>, not both.");
    if (targetAgentId !== undefined && agentId === undefined)
      throw runtimeSpawnError("squad_leader_required", "Targeted squad dispatch requires --agent <leader-id>.");
    if (squadId !== undefined && agentId === undefined)
      throw runtimeSpawnError("squad_leader_required", "Squad attribution requires --agent <leader-id>.");
    // An edge learns the task's worktree binding from the center in the read that also assembles its mission,
    // so its checkout follows that read; a local dispatch arrives with the checkout already prepared.
    const remoteTask =
        taskId && input.remote
          ? await input.remote.taskContext(
              taskId,
              missionName,
              role === "reviewer" ? { executionId: requestedExecutionId } : undefined,
              (release) => {
                claim.release = release;
              },
            )
          : null,
      projection = input.remote ? null : requiredRuntimeProjection(input);
    const reviewerBinding = role === "reviewer";
    assertReviewerTarget({
      reviewer: reviewerBinding,
      taskId,
      decisionTarget: decisionReviewTarget,
      taskTarget: taskReviewTarget,
      executionId: requestedExecutionId,
      remoteExecutionId: remoteTask?.executionId,
      remote: input.remote !== undefined,
    });
    // Every local spawn (runtime.run, squad turns, fallback continuations) runs in the RepoCell write queue.
    const taskSnapshot =
        taskId && !input.remote
          ? (admissionTaskRead ?? requireCurrentTaskProjection(projection!, taskId, "runtime.run")).snapshot
          : null,
      leaseAtAdmission = taskId && !input.remote ? projection!.currentLease(taskId) : null;
    taskDispatchAdmission.enforceRuntimeSpawnStewardshipFence(taskSnapshot, reviewerBinding, binding.actor);
    // A reviewer dispatch binds to the submitted cut under review — never to the task's active
    // implementation execution or lease — so it cannot observe, open, or mutate an implementation
    // iteration. Selection happens here so every entry (task dispatch-review, completion facade)
    // enforces the same invariant.
    const reviewTarget =
        reviewerBinding && taskId !== null
          ? selectReviewTarget(
              taskId,
              requestedExecutionId ?? taskReviewTarget?.executionId,
              taskSnapshot,
              input.remote != null,
              taskReviewTarget?.digest,
            )
          : null,
      { dispatchId: newDispatchId, runtimeSessionId } = runtimeDispatchIdentity(input.repoId, dispatchKey),
      dispatchOpId = randomUUID(),
      installationOpId = randomUUID(),
      trustedHandoffSource = handoffFromRuntimeSessionId ?? resumed?.header.runtimeSessionId ?? null;
    if (remoteTask && reviewerBinding && taskReviewTarget) {
      const currentDigest = remoteTask.reviewerSubmission ? submissionDigest(remoteTask.reviewerSubmission) : null;
      if (
        remoteTask.executionId !== taskReviewTarget.executionId ||
        ((remoteTask.reviewerSubmission !== undefined || inheritedFallback !== undefined) &&
          currentDigest !== taskReviewTarget.digest)
      )
        throw runtimeSpawnError(
          "review_cut_superseded",
          `Submitted cut for task ${taskReviewTarget.taskId} execution ${taskReviewTarget.executionId} was amended or superseded ` +
            `(expected digest ${taskReviewTarget.digest}, current ${currentDigest ?? "none"}).`,
        );
    }
    const authorizationDecision: AuthorizationDecision | null = binding.authorizationDecision ?? null;
    const frozenStatus = taskSnapshot?.task?.status,
      frozenTask = frozenStatus === "submitted" || frozenStatus === "in_review",
      // A declared read-only Agent identity attaches to the frozen round's submitted cut instead of
      // taking the implementation path: no lease, no new execution, the frozen cut untouched. The
      // criterion is the declaration's own permissionMode, resolved only on a frozen round: an
      // identity that does not positively resolve read-only keeps the frozen rejection below, and
      // a declaration that cannot resolve at all is its own dispatch error, never a quiet
      // read-only classification.
      readOnlyAttach =
        taskId !== null && !input.remote && !reviewerBinding && !dryRun && frozenTask
          ? input.resolveAgent !== undefined &&
            agentId !== undefined &&
            input.resolveAgent(agentId, taskSnapshot?.task?.metadata?.verticalId)?.permissionMode === "read-only"
          : false,
      attachTarget = readOnlyAttach ? selectReadOnlyAttachTarget(taskId!, taskSnapshot!) : null,
      arrangement = taskSnapshot ? currentExecutionArrangement(taskSnapshot) : undefined,
      arrangementKey = arrangement ? `task-arrangement:${arrangement.id}` : undefined,
      resumeKey =
        requestedDispatchId && projection
          ? projection.readRuntimeDispatchById(requestedDispatchId)?.event.payload.dispatchKey
          : undefined,
      arrangementId =
        payload.arrangementId !== undefined
          ? requiredRuntimeSpawnText(payload.arrangementId, "arrangementId")
          : arrangementKey &&
              (inheritedFallback?.rootDispatchKey === arrangementKey ||
                resumeKey === arrangementKey ||
                resumeKey?.startsWith(`${arrangementKey}:fallback:`))
            ? arrangement?.id
            : undefined;
    if (taskId && !input.remote && !reviewerBinding) {
      if (
        !dryRun &&
        taskSnapshot &&
        (!executionArrangementAllows(taskSnapshot, binding.actor, arrangementId, binding.source) ||
          (currentExecutionArrangement(taskSnapshot)?.agentId !== undefined &&
            currentExecutionArrangement(taskSnapshot)?.agentId !== agentId))
      )
        throw runtimeSpawnError(
          "execution_scope_mismatch",
          "This dispatch no longer owns the task execution arrangement.",
        );
      const leaseQualifies = taskDispatchAdmission.taskDispatchLeaseQualifies(
        leaseAtAdmission,
        binding.actor,
        runtimeSessionId,
        trustedHandoffSource,
        input.handoffTaskLease !== undefined,
      );
      // A dry-run preview assembles the injected prompt without lease or
      // authorization admission — it must answer before either exists.
      if (!dryRun && (!authorizationDecision || authorizationDecision.outcome !== "allowed"))
        throw runtimeSpawnError(
          "authorization_missing",
          "Runtime dispatch requires the center AuthorizationPort decision.",
        );
      if (!dryRun) taskDispatchAdmission.assertTaskDispatchPrerequisites(projection!, taskId);
      // A submitted round's cut is frozen: an implementation runtime dispatched now could never
      // write under its lease, so the conflict is rejected here instead of after the work is done.
      // A read-only attach is the exception: it writes nothing, so it may observe the frozen cut.
      if (!dryRun && !readOnlyAttach && frozenTask) throw runtimeTaskExecutionFrozenError(taskId, frozenStatus);
      if (!dryRun && !readOnlyAttach)
        requireTaskWriterAdmission((query) => projection!.readDispatchLifecycle(query), taskId, runtimeSpawnError);
      if (!dryRun && !readOnlyAttach && !leaseQualifies)
        throw runtimeSpawnError(
          "runtime_task_lease_required",
          runtimeTaskLeaseRequiredMessage(taskId, leaseAtAdmission),
        );
    }
    // A detached review checkout owns its worktree boundary; doc/artifact-only tasks own their
    // task-package boundary under authoredRoot; trusted Decision reviews are authorized only by
    // internal review dispatch entries. Ordinary caller-selected cwds (including Task-bound ones)
    // carry no trustedManagedCwd provenance and re-verify repository realpath containment on every attempt.
    const effectiveInheritedCwd = inherited?.cwd ?? inheritedFallbackCwd,
      inheritedTrustedManagedCwd: TrustedManagedCwdKind | undefined =
        trustedManagedCwd ?? (inherited?.cwd !== undefined ? resumed?.header.trustedManagedCwd : undefined),
      trustedDecisionReview = inheritedTrustedManagedCwd === "decision-package",
      fallbackNeedsRemoteReviewWorktree =
        remoteTask !== null &&
        remoteTask.worktree !== null &&
        inheritedFallback !== undefined &&
        reviewerBinding &&
        taskId !== null &&
        effectiveInheritedCwd !== undefined &&
        !existsSync(effectiveInheritedCwd),
      requestedDecisionPackageRoot = trustedDecisionReview
        ? dispatchDecisionPackageRoot(input.rootDir, payload, decisionReviewTarget)
        : null,
      inheritedManagedRoots = managedRootsForTrustedCwd(input.rootDir, inheritedTrustedManagedCwd),
      reviewerHasWorktree =
        reviewerBinding &&
        (remoteTask
          ? remoteTask.worktree !== null
          : preparedWorktree !== null ||
            (inheritedFallback !== undefined && inheritedTrustedManagedCwd === "worktree")),
      taskPackageRoot =
        requestedDecisionPackageRoot ??
        (reviewerHasWorktree ? null : dispatchTaskPackageRoot(input, taskId, remoteTask)),
      { cwd, worktree: dispatchWorktree } = resolveDispatchCwd(
        input.rootDir,
        payload,
        fallbackNeedsRemoteReviewWorktree ? undefined : effectiveInheritedCwd,
        remoteTask
          ? fallbackNeedsRemoteReviewWorktree || (inheritedFallback === undefined && !effectiveInheritedCwd)
            ? await prepareDispatchWorktree(
                input,
                { ...payload, ...(handoff ? { taskId: handoff.taskId, acceptedCommit: handoff.commit } : {}) },
                () => remoteTask.worktree,
                reviewerBinding
                  ? reviewTarget?.submission !== undefined || remoteTask.reviewerSubmission !== undefined
                    ? ((reviewTarget?.submission ?? remoteTask.reviewerSubmission)!.commitSha ?? null)
                    : undefined
                  : undefined,
              )
            : null
          : preparedWorktree,
        taskPackageRoot,
        inheritedManagedRoots,
      ),
      resolvedManagedCwd: TrustedManagedCwdKind | undefined =
        requestedDecisionPackageRoot !== null
          ? "decision-package"
          : taskPackageRoot !== null
            ? "task-package"
            : dispatchWorktree !== null
              ? "worktree"
              : payload.cwd === undefined && effectiveInheritedCwd !== undefined
                ? inheritedTrustedManagedCwd
                : undefined;
    const snapshotExpectations = parseDispatchSnapshotExpectations(payload),
      runtimeActor = `agent:runtime-session:${runtimeSessionId}`,
      [localRuntimeSessions, runtimeInstances, allowedInstanceIds, providerHealth] =
        await resolveRuntimeDispatchResources(input, input.remote, projection!, providerSessionId ?? undefined),
      {
        squad,
        delegatedBy,
        agent,
        resolvedSkills: rawResolvedSkills,
        preset,
      } = resolveDispatchAgent(
        input,
        binding,
        cwd,
        agentId,
        squadId,
        targetAgentId,
        taskSnapshot?.task?.metadata?.verticalId ?? remoteTask?.verticalId ?? undefined,
      );
    if (agent) assertAgentDispatchable(agent);
    const agentDeclarationDigest = agent === null ? null : computeAgentDeclarationDigest(agent),
      preparedSkillSnapshot =
        agent === null
          ? null
          : prepareDispatchSkillSnapshot({
              rootDir: input.rootDir,
              cwd,
              runtimeSessionId,
              skills: rawResolvedSkills,
            }),
      skillSnapshotDigest = preparedSkillSnapshot?.skillSnapshotDigest ?? null,
      resolvedSkills = preparedSkillSnapshot?.skills ?? [],
      snapshotFence = verifyDispatchSnapshotFence({
        ...snapshotExpectations,
        actualAgentDeclarationDigest: agentDeclarationDigest,
        actualSkillSnapshotDigest: skillSnapshotDigest,
      });
    if (!snapshotFence.ok) throw runtimeSpawnError(snapshotFence.code, snapshotFence.message);
    if (providerSessionId && !requestedDispatchId && !handoff) {
      await assertBareProviderSessionResumeIdentity({
        input,
        projection,
        providerSessionId,
        personId: binding.actor.principal.personId,
        taskId,
        agentId: agent?.id ?? null,
        agentDeclarationDigest,
        skillSnapshotDigest,
      });
    }
    // Every daemon-spawned runtime returns to that daemon. Task bindings constrain writes;
    // they do not determine whether the runtime needs a route or an authenticated principal.
    const unboundReadOnlyAgent =
        !taskId && !trustedSchedule && !reviewerBinding && agent !== null && agent.permissionMode === "read-only",
      daemonRoute = input.runtimeDaemonRoute;
    if (
      (taskId || trustedSchedule || reviewerBinding || unboundReadOnlyAgent || permissionMode === "read-only") &&
      !daemonRoute
    )
      throw runtimeSpawnError(
        "runtime_preconditions_unavailable",
        "Task-bound, scheduled, and read-only runtime spawn require a sealed daemon route before dispatch.",
      );
    const requestedRuntimeInstanceId =
      inheritedFallback?.candidates[inheritedFallback.candidateIndex ?? inheritedFallback.attemptIndex]?.instance ??
      explicitRuntimeInstanceId ??
      agent?.instance;
    if (requestedRuntimeInstanceId !== undefined)
      resolveRuntimeInstanceCandidates({
        requested: requestedRuntimeInstanceId,
        ...(payload.runtimeInstanceId === undefined ? {} : { explicitlyRequested: true }),
        providerSessionId: providerSessionId ?? undefined,
        agent,
        model,
        instances: runtimeInstances,
        allowedInstanceIds,
        sessions: localRuntimeSessions,
        health: providerHealth,
        now: input.now(),
      });
    // Validate named runtime models before preparing the submitted task cut.
    const { taskMission, mission, progressSnapshot, outputShape } = await resolveRuntimeMission({
        rootDir: input.rootDir,
        cwd,
        taskId,
        workspaceProgress: workspaceProgress ?? (input.remote ? await collectRuntimeWorkspaceProgress(cwd) : undefined),
        causalGitHistory,
        continuationSnapshotProvided: inheritedFallback !== undefined,
        continuationRequested:
          recoveryRequested || requestedDispatchId !== undefined || providerSessionId !== undefined,
        projection,
        remoteTask,
        lifecycleNode:
          taskId && input.remote && inheritedFallback === undefined
            ? await input.remote.readTaskLifecycleNode?.(taskId)
            : undefined,
        taskSnapshot,
        missionName,
        explicitMission,
        reviewerBinding: Boolean(reviewerBinding),
      }),
      fallbackMission = dispatchPromptTemplate(mission, newDispatchId);
    let modelSlotHeld = false;
    const releaseModelSlot = (): void => {
      if (!modelSlotHeld) return;
      modelSlotHeld = false;
      modelSlotQueue.release(runtimeSessionId);
    };
    if (!dryRun) {
      await modelSlotQueue.acquire({
        attemptId: runtimeSessionId,
        ownerKey: binding.actor.principal.personId,
        flowKey: taskId ?? dispatchKey,
      });
      modelSlotHeld = true;
    }
    const selectionHints = {
        ...(preferredRuntimeInstanceId === undefined ? {} : { preferredInstanceId: preferredRuntimeInstanceId }),
        ...(preferredModel === undefined ? {} : { preferredModel }),
        ...(avoidVendor === undefined ? {} : { avoidVendor }),
      },
      selectRuntime = () =>
        prepareRuntimeInstance(
          {
            requested: requestedRuntimeInstanceId,
            providerSessionId: providerSessionId ?? undefined,
            preferredInstanceId: preferredRuntimeInstanceId,
            avoidVendor,
            agent,
            model,
            instances: runtimeInstances,
            allowedInstanceIds,
            sessions: localRuntimeSessions,
            selectionStrategy: input.readSettings?.().runtime.selectionStrategy,
            dispatchState,
            dryRun,
            selectRuntimeInstance: input.selectRuntimeInstance,
            health: providerHealth,
            now: input.now(),
          },
          async (runtimeInstanceId) => {
            if (!dryRun) {
              const rows = await readActiveDispatchLifecycle(
                  (query) =>
                    input.remote ? input.remote.readDispatchLifecycle(query) : projection!.readDispatchLifecycle(query),
                  runtimeSpawnError,
                  runtimeInstanceId,
                ),
                refusal = dispatchAdmissionBlocker(rows, {
                  instanceId: runtimeInstanceId,
                  owner: dispatchOwnerForNode(input.runtimeNode?.nodeId),
                  capacity: input.runtimeInstanceCapacities?.[runtimeInstanceId],
                });
              if (refusal) throw runtimeSpawnError(refusal.code, refusal.message);
            }
            const initialFallback =
                inheritedFallback ??
                initialFallbackAttempt(
                  agent,
                  explicitRuntimeInstanceId,
                  model,
                  providerSessionId,
                  dispatchKey,
                  newDispatchId,
                  fallbackMission,
                  runtimeInstances,
                  localRuntimeSessions,
                  allowedInstanceIds,
                  providerHealth,
                  input.now(),
                  false,
                  selectionHints,
                ),
              fallbackAttempt =
                initialFallback &&
                initialFallback.candidates[initialFallback.candidateIndex ?? initialFallback.attemptIndex]?.instance !==
                  runtimeInstanceId
                  ? initialFallbackAttempt(
                      agent,
                      runtimeInstanceId,
                      model,
                      providerSessionId,
                      dispatchKey,
                      newDispatchId,
                      fallbackMission,
                      runtimeInstances,
                      localRuntimeSessions,
                      allowedInstanceIds,
                      providerHealth,
                      input.now(),
                      explicitRuntimeInstanceId === undefined,
                      selectionHints,
                    )
                  : initialFallback,
              fallbackAttemptForDispatch = fallbackAttempt,
              fallbackCandidate =
                fallbackAttemptForDispatch?.candidates[
                  fallbackAttemptForDispatch.candidateIndex ?? fallbackAttemptForDispatch.attemptIndex
                ],
              runtimeInstance = runtimeInstances.find((instance) => instance.instanceId === runtimeInstanceId),
              effectivePreferredModel =
                model === undefined &&
                runtimeInstance !== undefined &&
                runtimeInstanceId === preferredRuntimeInstanceId &&
                preferredModel !== undefined &&
                agentRuntimeModelMatches(runtimeInstance.models, preferredModel)
                  ? preferredModel
                  : undefined,
              // The instance store validates model membership verbatim, so a declaration that
              // differs from the catalog only by letter case must launch the catalog spelling.
              requestedSelectedModel =
                fallbackCandidate?.model ??
                model ??
                effectivePreferredModel ??
                (agent && runtimeInstance
                  ? agentRuntimeTargetForKind(agent.runtimes, runtimeInstance.kindId)?.model
                  : undefined),
              selectedModel =
                requestedSelectedModel === undefined || runtimeInstance === undefined
                  ? requestedSelectedModel
                  : (agentRuntimeModelSpelling(runtimeInstance.models, requestedSelectedModel) ??
                    requestedSelectedModel),
              selectedEffort =
                effort ??
                (agent && runtimeInstance
                  ? agentRuntimeTargetForKind(agent.runtimes, runtimeInstance.kindId)?.effort
                  : undefined),
              configuredPermissionMode = runtimeInstance?.permissionMode ?? undefined,
              requestedDispatchPermissionMode = validRuntimeLaunchPermissionMode(permissionMode)
                ? permissionMode
                : undefined,
              declaredPermissionMode =
                permissionMode !== undefined && requestedDispatchPermissionMode === undefined
                  ? permissionMode
                  : clampPermissionMode(agent?.permissionMode, requestedDispatchPermissionMode),
              effectivePermissionMode = declaredPermissionMode ?? configuredPermissionMode,
              declaredMcpPolicy = mcpPolicy ?? agent?.mcpPolicy,
              effectiveMcpPolicy = runtimeInstance
                ? resolveRuntimeMcpPolicy({
                    kindId: runtimeInstance.kindId,
                    dispatchMcpPolicy: mcpPolicy,
                    agentMcpPolicy: agent?.mcpPolicy,
                    instanceMcpPolicy: runtimeInstance.mcpPolicy ?? undefined,
                  })
                : declaredMcpPolicy
                  ? runtimeMcpPolicy(declaredMcpPolicy)
                  : undefined,
              callbackRelay = dispatchCallbackRelay(
                newDispatchId,
                daemonRoute,
                runtimeInstance,
                effectivePermissionMode,
              ),
              // A relayed sandbox still hides the host user root and daemon id; a bypass worker
              // already has that host access and keeps the real identity in its mission. Only the
              // endpoint is shared: the relay is located by the injected socket path.
              missionDaemonRoute =
                callbackRelay && daemonRoute
                  ? {
                      ...(effectivePermissionMode === "bypass" ? daemonRoute : { userRoot: "", daemonId: "" }),
                      endpoint: callbackRelay.path,
                    }
                  : daemonRoute,
              selfContainedMission =
                taskMission && daemonRoute
                  ? assembleTaskMission({
                      mission,
                      progressSnapshot,
                      repoId: input.repoId,
                      workerRoot: cwd,
                      worktreeNote: dispatchWorktree ? taskWorktreeCheckoutNote(dispatchWorktree) : null,
                      taskId: taskId!,
                      taskPackageRoot: taskMission.packageRoot,
                      daemonRoute: missionDaemonRoute!,
                      runtimeActor,
                    })
                  : trustedSchedule && daemonRoute
                    ? assembleScheduledMission({
                        mission,
                        repoId: input.repoId,
                        workerRoot: cwd,
                        scheduleId: trustedSchedule.scheduleId,
                        mode: trustedSchedule.mode,
                        claimFence: trustedSchedule.claimFence,
                        daemonRoute: missionDaemonRoute!,
                        runtimeActor,
                      })
                    : mission,
              readOnlyDispatch = effectivePermissionMode === "read-only",
              // The mounted skill opts both delivery and review dispatches in (`dec_43F5EA40143C5BD729EF90D030` CH1).
              // Delivery proposals go in the task package, review proposals in the review report, and read-only dispatches omit them.
              selfIteration =
                taskId !== null && !readOnlyDispatch
                  ? selfIterationCloseoutSection(
                      taskId,
                      resolvedSkills.map((skill) => skill.id),
                      reviewerBinding ? "review" : "delivery",
                    )
                  : null,
              dispatchMission = dispatchMissionForPermission(
                selfIteration === null
                  ? (selfContainedMission ?? mission)
                  : `${selfContainedMission ?? mission}\n\n${selfIteration}`,
                effectivePermissionMode,
                {
                  kindId: runtimeInstance?.kindId ?? "",
                  platform: hostPlatform,
                  reviewer: reviewerBinding,
                  taskBound: taskId !== null,
                },
              ),
              // Resolve mission and declaration ledger reads to paths available in the worker worktree.
              // Include the isolated-test entry when no dispatch input already names it.
              privateReads = privateLedgerReadSection(
                resolvePrivateLedgerReads({
                  rootDir: input.rootDir,
                  cwd,
                  ...(preparedSkillSnapshot ? { snapshotPaths: preparedSkillSnapshot.sourceToSnapshotPath } : {}),
                  texts: dispatchLedgerReadTexts({
                    prompts: agent?.prompts ?? [],
                    instructions: agent?.instructions,
                    mission: dispatchMission,
                    reviewer: reviewerBinding,
                    readOnly: readOnlyDispatch,
                  }),
                }),
              ),
              assembledPrompt = agent
                ? assembleAgentPrompt(
                    role === "reviewer" ? { ...agent, role } : agent,
                    dispatchMission,
                    preset,
                    resolvedSkills,
                    privateReads,
                    outputShape,
                  )
                : taskMission || role === "reviewer"
                  ? assembleUnboundPrompt(
                      dispatchMission,
                      role === "reviewer" ? role : undefined,
                      privateReads,
                      outputShape,
                    )
                  : dispatchMission,
              // Scheduled Squad leaders answer the squad decision protocol; the run settles
              // the occurrence. Every dispatch still receives its own rendered dispatch id.
              prompt = renderDispatchPrompt(
                assembledPrompt,
                newDispatchId,
                Boolean(trustedSchedule) && squadId === undefined,
              );
            assertContextBudget(prompt);

            // Dry-run preview ends exactly at the launch boundary: the same inputs, same
            // assembly calls, no prepareLaunch, no dispatch event, no lease handoff.
            const preview = dryRun
              ? {
                  schema: "agent-dispatch-preview/v1",
                  ok: true,
                  command: "runtime-spawn",
                  dispatchId: newDispatchId,
                  runtimeSessionId,
                  effort: selectedEffort ?? null,
                  agentDeclarationDigest,
                  skillSnapshotDigest,
                  prompt,
                  mission,
                }
              : null;
            let cloudRelay: Awaited<ReturnType<NonNullable<RuntimeSpawnerInput["prepareCloudRelay"]>>> | null = null;
            let prepared: Awaited<ReturnType<RuntimeSpawnerInput["prepareLaunch"]>> | null = null;
            if (!dryRun) {
              if (preparedSkillSnapshot) materializeDispatchSkillSnapshot(preparedSkillSnapshot);
              const budgetMicros = selectedModel ? relayBudgetMicrosOf(selectedModel, dispatchUsageLimit) : null;
              try {
                cloudRelay =
                  input.prepareCloudRelay &&
                  !Object.hasOwn(input.cloudRuntime?.instanceTargets ?? {}, runtimeInstanceId) &&
                  budgetMicros !== null &&
                  selectedModel
                    ? await input.prepareCloudRelay({
                        instanceId: runtimeInstanceId,
                        attemptId: runtimeSessionId,
                        model: selectedModel,
                        budgetMicros,
                      })
                    : null;
                prepared = await input.prepareLaunch(runtimeInstanceId, {
                  cwd,
                  repoRoot: input.rootDir,
                  prompt,
                  ...(selectedModel ? { model: selectedModel } : {}),
                  ...(selectedEffort ? { effort: selectedEffort } : {}),
                  ...(fast === undefined ? {} : { fast }),
                  ...(declaredPermissionMode ? { permissionMode: declaredPermissionMode } : {}),
                  ...(effectiveMcpPolicy ? { mcpPolicy: effectiveMcpPolicy } : {}),
                  ...(callbackRelay ? { callbackRelayPath: callbackRelay.path } : {}),
                  ...(providerSessionId ? { providerSessionId } : {}),
                  ...(cloudRelay ? { cloudRelay: { baseUrl: cloudRelay.baseUrl, token: cloudRelay.token } } : {}),
                  runtimeSessionId,
                  handshakeTimeoutMs: input.readSettings?.().runtime.providerHandshakeTimeoutMs,
                  commandInterceptions: (input.readSettings?.().runtime.commandInterceptions ?? []).filter(
                    (rule) => rule.agent === undefined || rule.agent === agent?.id,
                  ),
                });
              } catch (error) {
                await cloudRelay?.close();
                throw error;
              }
            }
            const result = {
              fallbackAttempt: fallbackAttemptForDispatch,
              runtimeInstance,
              effectivePermissionMode,
              effectiveMcpPolicy,
              callbackRelay,
              readOnlyDispatch,
              prompt,
              prepared,
              cloudRelay,
              preview,
            };
            return result;
          },
        );
    let selection: Awaited<ReturnType<typeof selectRuntime>>;
    try {
      selection = await selectRuntime();
    } catch (error) {
      reclaimSessionSkillSnapshot(input.rootDir, runtimeSessionId, cwd);
      releaseModelSlot();
      throw error;
    }
    const runtimeInstanceId = selection.instanceId,
      {
        runtimeInstance,
        effectivePermissionMode,
        effectiveMcpPolicy,
        callbackRelay,
        readOnlyDispatch,
        prompt,
        preview,
        cloudRelay,
      } = selection.launch;
    if (preview) return preview;
    const effectiveSelectionModel =
        model ??
        (runtimeInstanceId === preferredRuntimeInstanceId &&
        runtimeInstance !== undefined &&
        preferredModel !== undefined &&
        agentRuntimeModelMatches(runtimeInstance.models, preferredModel)
          ? preferredModel
          : undefined),
      runtimeSelection = selectedRuntimeInstance({
        agent,
        ...(effectiveSelectionModel === undefined ? {} : { model: effectiveSelectionModel }),
        instances: runtimeInstances,
        selected: runtimeInstanceId,
        selectionStrategy: input.readSettings?.().runtime.selectionStrategy,
        ...(explicitRuntimeInstanceId === undefined ? {} : { explicitlyRequested: true }),
        ...(providerSessionId === null || providerSessionId === undefined ? {} : { resumedSession: true }),
      }),
      prepared = selection.launch.prepared!,
      fallbackAttempt = selection.launch.fallbackAttempt,
      definition = prepared.definition,
      installation = prepared.installation,
      declaredKindId = runtimeKindForId(definition.kindId).kindId,
      launchedPermissionMode = runtimePermissionMode(effectivePermissionMode, declaredKindId),
      requestedPermissionMode =
        permissionMode === undefined ? null : (runtimePermissionMode(permissionMode, declaredKindId) ?? null),
      permissionModeSource: RuntimePermissionModeSource =
        permissionMode !== undefined &&
        (agent?.permissionMode === undefined || launchedPermissionMode === requestedPermissionMode)
          ? "dispatch"
          : agent?.permissionMode !== undefined
            ? "agent"
            : (runtimeInstance?.permissionMode ?? undefined) !== undefined
              ? "instance"
              : "default",
      launchedMcpPolicy = runtimeSupportsMcpPolicy(declaredKindId)
        ? (effectiveMcpPolicy ?? definition.mcpPolicy ?? "disabled")
        : undefined;
    const executionTarget = runtimeSpawnerDelegates.runtimeExecutionTarget(input.cloudRuntime, definition.instanceId);
    const cloudTarget = executionTarget.kind === "cloud" ? executionTarget : undefined;
    const executionAttempt = fallbackAttempt?.attemptIndex ?? 0;
    const tasklessExecutionRole =
        !taskId && !trustedSchedule && !reviewerBinding && !decisionReviewTarget
          ? runtimeExecutionRoleForLaunch({
              taskId: null,
              role: role === "reviewer" ? "reviewer" : "session",
              readOnlyCeiling: launchedPermissionMode === "read-only" || unboundReadOnlyAgent,
            })
          : null,
      dispatchRole =
        tasklessExecutionRole === "read-only"
          ? "read-only"
          : taskId && !readOnlyAttach && !reviewerBinding && agent?.role === "commander" && role === undefined
            ? "coordinator"
            : role;
    if (dispatchRole === "read-only" && !daemonRoute)
      throw runtimeSpawnError(
        "runtime_preconditions_unavailable",
        "Read-only runtime spawn requires a sealed daemon route before dispatch.",
      );
    const definitionArtifact = runtimeDefinitionSnapshotArtifact(definition),
      definitionSnapshotRef = definitionArtifact.ref,
      runtimeKind = runtimeKindForId(definition.kindId),
      protocolFamily = runtimeKind.protocolFamily;
    let activeBinding: RuntimeBinding,
      taskLeaseHandoff: RuntimeSpawnerInput["handoffTaskLease"],
      releaseUnadmittedLease: (() => Promise<void>) | undefined,
      taskBinding: ActiveRuntime["task"] = null;
    // prepareLaunch already minted this run's temp scope. Every refusal in this admission window
    // happens before a stream or process exists, so the scope is the only resource to hand back.
    try {
      assertPreparedRuntimeLaunch(prepared, {
        instanceId: runtimeInstanceId,
        kindId: runtimeInstance?.kindId,
        cwd,
        prompt,
        permissionMode: launchedPermissionMode,
        agentId: agent?.id,
      });
      if ((taskId || trustedSchedule || reviewerBinding) && !(taskId && outputShape === "task-package-artifact"))
        await configureWorkerGitIdentity(cwd, input.rootDir, binding.actor.principal.personId);
      if (handoff) await verifyHandoffWorktree(cwd, handoff.commit);
      if (
        reviewerBinding &&
        inheritedFallback !== undefined &&
        dispatchWorktree === null &&
        remoteTask?.worktree !== null &&
        typeof remoteTask?.reviewerSubmission?.commitSha === "string"
      )
        await verifyReviewCheckout(cwd, remoteTask.reviewerSubmission.commitSha);
      // Every implementation runtime, including squad leaders, takes the actual lease. A read-only
      // attach takes none: it never asks for the handoff, so the frozen round's lease state stays untouched.
      taskLeaseHandoff =
        taskId && !input.remote && !reviewerBinding && !readOnlyAttach ? input.handoffTaskLease : undefined;
      const leaseHandoff = taskLeaseHandoff
        ? await taskLeaseHandoff({
            taskId: taskId!,
            runtimeSessionId,
            fromRuntimeSessionId: trustedHandoffSource,
            ...(arrangementId ? { arrangementId } : {}),
            binding,
          })
        : null;
      activeBinding = leaseHandoff?.binding ?? binding;
      releaseUnadmittedLease = leaseHandoff?.releaseUnadmittedLease;
      const lease = taskId && !input.remote ? projection!.currentLease(taskId) : null;
      if (
        taskId &&
        taskLeaseHandoff &&
        (lease?.phase !== "held" || lease.actor.executor?.id !== `runtime-session:${runtimeSessionId}`)
      )
        throw runtimeSpawnError("runtime_task_lease_required", runtimeTaskLeaseRequiredMessage(taskId, lease));
      taskBinding = taskId
        ? {
            taskId,
            executionId:
              remoteTask?.executionId ??
              (reviewerBinding
                ? reviewTarget!.executionId
                : readOnlyAttach
                  ? attachTarget!.executionId
                  : lease!.executionId),
            // A reviewer and a read-only attach hold no lease; carrying another executor's
            // leaseVersion would misstate the session's write authority in every downstream
            // binding check.
            leaseVersion: reviewerBinding || readOnlyAttach ? null : (lease?.version ?? null),
          }
        : null;
    } catch (error) {
      reclaimFailedLaunchTempDirectory(input, runtimeInstanceId, runtimeSessionId);
      throw error;
    }
    const streamStartedAt = input.now();
    let process: RuntimeExecutionHandle | undefined;
    let launchMayBeRunning = false;
    let active: ActiveRuntime | undefined = undefined;
    let resumeObservation: ResumeProcessObservation | undefined;
    let stream: DispatchStreamWriter | undefined;
    // Freeze the provider directory this launch's environment actually resolved (explicit
    // config-home, platform home, or the isolated state root) into the dispatch stream before
    // the process starts: native handoff export and settlement metrics read this witness, never
    // the instance's mutable current configuration. Null when the environment has no home.
    // The witness uses the module-level host platform; the local `process` is the launched
    // RuntimeProcess and carries no platform.
    const resolvedProviderDirectory = sharedProviderDirectory(prepared.env, declaredKindId, hostPlatform);
    // Freeze the declared cap with the launch: a running dispatch keeps the limit it was admitted
    // under, and an adopting daemon restores it from the stream header instead of re-reading a
    // setting that may have changed. 0 is the declared "no limit" sentinel.
    const currentSettings = input.readSettings?.(),
      declaredTokenLimit = currentSettings?.runtime.dispatchUsageLimit ?? 0,
      tokenLimit = declaredTokenLimit > 0 ? declaredTokenLimit : null,
      stallTimeoutMs = currentSettings?.runtime.stallTimeoutMs ?? DEFAULT_RUNTIME_STALL_TIMEOUT_MS;
    const openStream = (): DispatchStreamWriter =>
      (stream ??= openDispatchStream(input.rootDir, {
        dispatchId: newDispatchId,
        ...(cloudTarget ? { executionTarget: cloudTarget, executionAttempt } : {}),
        taskId: taskBinding?.taskId ?? null,
        executionId: taskBinding?.executionId ?? null,
        ...(decisionReviewTarget
          ? { reviewTarget: decisionReviewTarget }
          : reviewerBinding && taskBinding && (reviewTarget?.submission ?? remoteTask?.reviewerSubmission)
            ? {
                reviewTarget: {
                  kind: "task" as const,
                  taskId: taskBinding.taskId,
                  executionId: taskBinding.executionId,
                  digest: submissionDigest((reviewTarget?.submission ?? remoteTask?.reviewerSubmission)!),
                },
              }
            : {}),
        ...(resolvedManagedCwd ? { trustedManagedCwd: resolvedManagedCwd } : {}),
        ...(typeof taskBinding?.leaseVersion === "number" ? { leaseVersion: taskBinding.leaseVersion } : {}),
        ...(trustedSchedule ? { schedule: trustedSchedule } : {}),
        runtimeSessionId,
        instanceId: definition.instanceId,
        ...(resolvedProviderDirectory ? { resolvedProviderDirectory } : {}),
        startedAt: streamStartedAt,
        dispatchOpId,
        kindId: definition.kindId,
        permissionMode: launchedPermissionMode ?? null,
        mcpPolicy: launchedMcpPolicy ?? null,
        binding: runtimeBindingForDispatch(activeBinding),
        executionOwner: input.runtimeNode ?? "local",
        cwd,
        prompt: scrubProviderValue(prompt) as string,
        mission: scrubProviderValue(mission) as string,
        ...(fallbackAttempt ? { fallbackAttempt } : {}),
        ...(promptSource ? { promptSource } : {}),
        model: definition.model,
        reasoningEffort: definition.reasoningEffort,
        fast: definition.fast ?? false,
        evidenceTrackingVersion: 1,
        steerReceiptProtocolVersion: 1,
        ...(tokenLimit === null ? {} : { tokenLimit }),
        stallTimeoutMs,
        resumeProviderSessionId: providerSessionId ?? null,
        ...(handoffEnabled ? { handoffEnabled: true } : {}),
        ...(handoff
          ? { resumedFromDispatchId: handoff.dispatchId }
          : requestedDispatchId
            ? { resumedFromDispatchId: requestedDispatchId }
            : {}),
        ...(onExitCommand ? { onExitCommand } : {}),
        ...(dispatchRole ? { role: dispatchRole } : {}),
        ...(agent ? { agentId: agent.id, agentName: agent.name } : {}),
        ...(agentDeclarationDigest ? { agentDeclarationDigest } : {}),
        ...(skillSnapshotDigest ? { skillSnapshotDigest } : {}),
        ...(squad ? { squadId: squad.squadId } : {}),
        publicationOwner,
        ...(parentRuntimeSessionId ? { parentRuntimeSessionId } : {}),
        ...(delegatedBy
          ? {
              delegatedByAgentId: delegatedBy.id,
              delegatedByAgentName: delegatedBy.name,
            }
          : {}),
      }));
    let requested: Awaited<ReturnType<typeof publishRuntimeEvent>> | undefined,
      dispatchRequestSent = false,
      releaseUnadmittedClaim: (() => Promise<void>) | undefined;
    const requestDispatch = () =>
      publishRuntimeEvent(
        "runtime_dispatch_requested",
        runtimeDispatchRequestedPayload(
          {
            dispatchId: newDispatchId,
            runtimeSessionId,
            instanceId: definition.instanceId,
            installationId: definition.installationId,
            kindId: installation.kindId,
            dispatchKey,
            ...(cloudTarget ? { executionTarget: cloudTarget } : {}),
            definitionSnapshotRef,
            definitionSnapshot: definition,
            startedAt: streamStartedAt,
            ...(payload.squadRun ? { squadRun: payload.squadRun as unknown as SquadDispatchContext } : {}),
            ...(handoffEnabled ? { handoffEnabled: true } : {}),
            ...(providerSessionId ? { resumeProviderSessionId: providerSessionId } : {}),
            ...(handoff ? { handoffCheckpointId: handoff.dispatchId, acceptedCommit: handoff.commit } : {}),
          },
          {
            ...((handoff?.dispatchId ?? requestedDispatchId)
              ? { resumedFromDispatchId: handoff?.dispatchId ?? requestedDispatchId }
              : {}),
            ...(taskBinding ? { taskBinding } : {}),
            attemptGroupId: fallbackAttempt?.attemptGroupId ?? newDispatchId,
            attemptIndex: fallbackAttempt?.attemptIndex ?? 0,
            ...(agent ? { agent } : {}),
            ...(agentDeclarationDigest ? { agentDeclarationDigest } : {}),
            ...(skillSnapshotDigest ? { skillSnapshotDigest } : {}),
            ...(squad ? { squadId: squad.squadId } : {}),
            cwd,
            ...(dispatchRole ? { role: dispatchRole } : {}),
            ...(launchedPermissionMode !== undefined ? { launchedPermissionMode } : {}),
            requestedPermissionMode,
            permissionModeSource,
            ...(decisionReviewTarget ? { decisionReviewTarget } : {}),
            ...(reviewerBinding && (reviewTarget?.submission ?? remoteTask?.reviewerSubmission)
              ? { reviewerSubmission: (reviewTarget?.submission ?? remoteTask?.reviewerSubmission)! }
              : {}),
          },
        ),
        dispatchOpId,
        binding,
        definitionArtifact.body,
        {
          role: dispatchRole ?? null,
          taskId: taskBinding?.taskId ?? null,
          executionId: taskBinding?.executionId ?? null,
          launchGeneration: input.daemonGeneration,
        },
      );
    const cleanupCallbackRelay = (): void => {
      if (callbackRelay) removeRuntimeCallbackRelay(newDispatchId);
    };
    const cleanupFailedLaunch = async (error: unknown): Promise<{ readonly fallbackPending: boolean }> => {
      active?.releaseAuthorization?.();
      if (!process?.cloud) process?.terminate();
      if (process?.cloud && active) activeRuntimeHandles.delete(runtimeSessionId);
      const cloudStopped = await process?.cloud?.stop();
      process?.release?.();
      releaseModelSlot();
      await cloudRelay?.close();
      cleanupCallbackRelay();
      reclaimFailedLaunchTempDirectory(input, runtimeInstanceId, runtimeSessionId);
      reclaimSessionSkillSnapshot(input.rootDir, runtimeSessionId, cwd);
      const reclaimUnadmittedReviewWorktree = async (): Promise<void> => {
        if (role !== "reviewer" || inheritedFallback !== undefined) return;
        const targetPath = resolveManagedReviewWorktreePath(input.rootDir, cwd);
        if (targetPath === null) return;
        const inUseBySibling = () =>
          [...activeRuntimeHandles.values()].some(
            (entry) =>
              entry.runtimeSessionId !== runtimeSessionId &&
              (entry.cwd === cwd ||
                entry.cwd === targetPath ||
                resolveManagedReviewWorktreePath(input.rootDir, entry.cwd) === targetPath),
          );
        if (inUseBySibling()) return;
        const reviewCleanupFailure = await reclaimReviewWorktree(input.rootDir, targetPath, () => !inUseBySibling());
        if (reviewCleanupFailure)
          console.error(`[review-worktree] ${newDispatchId} could not be reclaimed: ${reviewCleanupFailure.message}`);
      };
      if (
        cloudStopped === false ||
        (process && !process.cloud && !(await runtimeProcessTreeStopped(input.rootDir, newDispatchId, process)))
      )
        return { fallbackPending: false };
      if (!process && launchMayBeRunning) return { fallbackPending: false };
      dispatchState.deactivate(runtimeSessionId);
      // A lost receipt (including credential issuance after commit) does not undo admission.
      // Center reads must be ready; an unavailable read preserves the stream and claim for recovery.
      const observed =
          !requested && dispatchRequestSent && input.remote
            ? readyDispatchLifecycle(
                await input.remote.readDispatchLifecycle({ by: "dispatch", dispatchIds: [newDispatchId] }),
                runtimeSpawnError,
              )[0]
            : null,
        admitted =
          requested || observed || (dispatchRequestSent && !input.remote && input.store!().readEvent(dispatchOpId));
      if (observed?.policy.attemptSettled) {
        if (stream) removeDispatchStream(input.rootDir, newDispatchId);
        return { fallbackPending: false };
      }
      if (!admitted) {
        await reclaimUnadmittedReviewWorktree();
        await releaseUnadmittedLease?.();
        await releaseUnadmittedClaim?.();
        if (stream) removeDispatchStream(input.rootDir, newDispatchId);
        return { fallbackPending: false };
      }
      if (!process && !launchMayBeRunning && isRuntimeProcessStartRejected(error)) {
        return settleStartRejectedAttempt({
          context: extracted,
          stream: openStream(),
          dispatchId: newDispatchId,
          runtimeSessionId,
          instanceId: definition.instanceId,
          kindId: declaredKindId,
          model: definition.model,
          role: dispatchRole ?? null,
          cwd,
          startedAt: streamStartedAt,
          task: taskBinding,
          schedule: trustedSchedule ?? null,
          binding: activeBinding,
          fallbackAttempt: fallbackAttempt ?? null,
          resumeProviderSessionId: providerSessionId ?? null,
          error,
        });
      }
      await publishRuntimeEvent("runtime_session_exited", { runtimeSessionId }, randomUUID(), activeBinding);
      const scrubbedError = String(scrubProviderValue(runtimeErrorMessage(error)))
          .trim()
          .slice(0, 1024),
        rawErrorCode = runtimeErrorCode(error),
        errorCode = typeof rawErrorCode === "string" && rawErrorCode.trim() ? rawErrorCode.trim() : undefined,
        attemptReason = scrubbedError || errorCode || "Runtime dispatch failed before provider registration.",
        failureClassification = "provider_fault" as const,
        fallbackDisposition = inheritedFallback !== undefined ? { fallbackState: "exhausted" as const } : {},
        attemptOutcome = {
          classification: failureClassification,
          reason: attemptReason,
          ...fallbackDisposition,
        },
        body = `Runtime dispatch failed before provider registration: ${attemptReason}`,
        sha256 = sha256Text(body),
        terminal = await publishRuntimeEvent(
          "runtime_session_outcome_observed",
          {
            runtimeSessionId,
            dispatchId: newDispatchId,
            outcome: "failed",
            exitCode: null,
            resultRef: `artifact:runtime-result/sha256/${sha256}`,
            result: { sha256, size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" },
            ...(errorCode ? { reasonCode: errorCode } : {}),
            endedAt: input.now(),
            attempt: attemptOutcome,
          },
          randomUUID(),
          activeBinding,
          body,
        );
      if (terminal.event) input.onRuntimeOutcome?.(terminal.event, trustedSchedule ?? null);
      const settledRead = await readDispatchLifecycle(extracted, { by: "dispatch", dispatchIds: [newDispatchId] }),
        settledLifecycle = settledRead.status === "ready" ? settledRead.rows[0] : undefined;
      if (settledLifecycle?.policy.groupSettled) {
        await releaseFallbackResources(
          extracted,
          settledLifecycle,
          dispatchRole ?? null,
          cwd,
          settledLifecycle.groupDispatchIds.length > 1,
        );
        if (settledLifecycle.groupDispatchIds.length <= 1 && stream) removeDispatchStream(input.rootDir, newDispatchId);
      } else if (settledRead.status === "ready" && settledLifecycle !== undefined) {
        await reclaimUnadmittedReviewWorktree();
      }
      return { fallbackPending: false };
    };
    try {
      await publishRuntimeEvent(
        "runtime_installation_observed",
        {
          installationId: installation.installationId,
          kindId: installation.kindId,
          protocolFamily,
          hostRef: cloudTarget ? `host:cloud:${cloudTarget.hostId}` : "host:local",
          version: installation.version,
          discoverySource: "wrapper",
          capabilities: runtimeKind.declaredCapabilities,
        },
        installationOpId,
        binding,
      );
      onDispatched?.(newDispatchId, runtimeSessionId);
    } catch (error) {
      await cleanupFailedLaunch(error);
      throw error;
    }
    try {
      if (cloudTarget && handoff)
        throw runtimeSpawnError(
          "runtime_handoff_target_unsupported",
          "Cloud sandbox targets cannot import native handoff rollouts.",
        );
      assertRuntimeHandoffLaunch(
        handoffEnabled,
        handoff,
        { taskId, agentId, role, trustedSchedule },
        definition.kindId,
        installation.version,
      );
    } catch (error) {
      await cleanupFailedLaunch(error);
      throw error;
    }
    if (handoff) {
      try {
        if (!handoffRollout)
          throw runtimeSpawnError(
            "runtime_handoff_payload_invalid",
            "The handoff claim lost its verified rollout body.",
          );
        if (!resolvedProviderDirectory)
          throw runtimeSpawnError(
            "invalid_runtime_launch",
            "The prepared target launch resolved no provider home directory.",
          );
        installHandoffRollout(resolvedProviderDirectory, handoff.providerSessionId, handoffRollout);
      } catch (error) {
        await cleanupFailedLaunch(error);
        throw error;
      }
    }
    const launchPreparedProcess = async (): Promise<{
      process: RuntimeExecutionHandle;
      resumeObservation?: ResumeProcessObservation;
    }> => {
      const boundLaunch = await prepareBoundRuntimeLaunch({
        input,
        prepared,
        daemonRoute,
        callbackRelay,
        cliBinDir: daemonCliBinDirectory(),
        runtimeActor,
        taskId,
        trustedSchedule,
        ...(taskId && !readOnlyAttach
          ? {
              execution: {
                repoId: input.repoId,
                personId: activeBinding.actor.principal.personId,
                source: activeBinding.source,
                runtimeSessionId,
                dispatchId: newDispatchId,
                taskId,
                executionId: taskBinding!.executionId,
                role: reviewerBinding ? "reviewer" : dispatchRole === "coordinator" ? "coordinator" : "implementation",
                surfaces: taskExecutionSurfaces(
                  taskSnapshot?.task ?? null,
                  reviewerBinding ? "reviewer" : dispatchRole === "coordinator" ? "coordinator" : "implementation",
                ),
              },
            }
          : {}),
        ...(!taskId && !reviewerBinding && !decisionReviewTarget && daemonRoute
          ? {
              execution: {
                repoId: input.repoId,
                personId: activeBinding.actor.principal.personId,
                source: activeBinding.source,
                runtimeSessionId,
                dispatchId: newDispatchId,
                taskId: null,
                executionId: null,
                role: dispatchRole === "read-only" ? "read-only" : "session",
              },
            }
          : {}),
      });
      const workerLaunch = {
        ...boundLaunch,
        env: {
          ...boundLaunch.env,
          HARNESS_WORKER_PERMISSION_MODE: input.readSettings?.().workerPermissions?.mode ?? "full",
        },
      };
      if (cloudTarget) {
        dispatchState.activate(runtimeSessionId, definition.instanceId);
        launchMayBeRunning = true;
        const executionCredential = boundLaunch.env.HARNESS_EXECUTION_CREDENTIAL;
        return {
          process: (process = openCloudRuntime({
            rootDir: input.rootDir,
            registration: input.cloudRuntime,
            target: cloudTarget,
            attempt: { repoId: input.repoId, dispatchId: newDispatchId, runtimeSessionId, attempt: executionAttempt },
            now: input.now,
            launch: {
              instanceId: definition.instanceId,
              kindId: declaredKindId,
              model: definition.model,
              prompt,
              ...(providerSessionId ? { providerSessionId } : {}),
              ...(launchedPermissionMode ? { permissionMode: launchedPermissionMode } : {}),
              ...(launchedMcpPolicy ? { mcpPolicy: launchedMcpPolicy } : {}),
              taskId: taskBinding?.taskId ?? null,
              executionId: taskBinding?.executionId ?? null,
              ...(executionCredential ? { executionCredential } : {}),
            },
          })),
        };
      }
      return launchRuntimeProcess(
        (...args) => {
          // Reserve before crossing the launcher port: another repository may dispatch while
          // the host starts the process or the provider is still confirming a resumed session.
          dispatchState.activate(runtimeSessionId, definition.instanceId);
          launchMayBeRunning = true;
          try {
            return (process = launch(...args));
          } catch (error) {
            if (isRuntimeProcessStartRejected(error)) launchMayBeRunning = false;
            throw error;
          }
        },
        workerLaunch,
        {
          rootDir: input.rootDir,
          dispatchId: newDispatchId,
          ...(callbackRelay ? { callbackRelay } : {}),
        },
        providerSessionId,
      );
    };
    if (providerSessionId && !cloudTarget && !input.remote && !handoff) {
      if (!requestedDispatchId) assertNativeResumeNotExported(input.rootDir, providerSessionId, projection!);
      try {
        openStream();
        ({ process, resumeObservation } = await launchPreparedProcess());
      } catch (error) {
        await cleanupFailedLaunch(error);
        throw error;
      }
    }
    try {
      openStream();
      onPrepared?.(newDispatchId, runtimeSessionId);
      dispatchRequestSent = true;
      // The acceptance boundary now owns claim cleanup. A missing reply must not let the
      // outer preparation rollback release an accepted or still-unknown task claim.
      releaseUnadmittedClaim = claim.release;
      claim.release = undefined;
      requested = await requestDispatch();
    } catch (error) {
      await cleanupFailedLaunch(error);
      throw error;
    }
    if (requested.receipt?.reused === true) {
      releaseModelSlot();
      await cloudRelay?.close();
      cleanupCallbackRelay();
      return {
        ...requested.receipt,
        runtimeSessionId,
        dispatchId: newDispatchId,
        authorizationDecision: authorizationDecision as unknown as JsonObject | null,
      };
    }
    const buildSpawnReceipt = (): JsonObject => {
      if (!requested?.event || (!requested.receipt && !requested.publication))
        throw runtimeSpawnError("runtime_event_missing", "A dispatch start must have an accepted event.");
      return runtimeSpawnerDelegates.decorateSpawnReceipt({
        receipt:
          requested.receipt ??
          runtimeSpawnReceipt(requested.event, requested.publication!, runtimeSessionId, newDispatchId),
        runtimeSessionId,
        dispatchId: newDispatchId,
        runtimeSelection,
        model: definition.model,
        agent,
        runtimeInstances,
        selectionStrategy: input.readSettings?.().runtime.selectionStrategy,
        githubCredentialNotice: prepared.githubCredentialNotice,
        readOnlyDispatch,
        authorizationDecision,
      });
    };
    if (!process)
      try {
        openStream();
        ({ process, resumeObservation } = await launchPreparedProcess());
      } catch (error) {
        const cleaned = await cleanupFailedLaunch(error);
        if (cleaned.fallbackPending) {
          const receipt = buildSpawnReceipt();
          return receipt;
        }
        throw error;
      }
    const runtimeProcess = process!;
    const releasedRuntimeProcess: RuntimeExecutionHandle = {
      ...runtimeProcess,
      release: () => {
        runtimeProcess.release?.();
        releaseModelSlot();
        void cloudRelay?.close();
      },
    };
    active = createActiveRuntime({
      process: releasedRuntimeProcess,
      dispatchId: newDispatchId,
      runtimeSessionId,
      dispatchOpId,
      instanceId: definition.instanceId,
      kindId: declaredKindId,
      resolvedProviderDirectory: resolvedProviderDirectory ?? null,
      permissionMode: launchedPermissionMode ?? null,
      mcpPolicy: launchedMcpPolicy ?? null,
      agent,
      role: dispatchRole ?? null,
      delegatedBy,
      squadId: squad?.squadId ?? null,
      publicationOwner,
      parentRuntimeSessionId: parentRuntimeSessionId ?? null,
      binding: activeBinding,
      task: taskBinding,
      decisionReviewTarget,
      schedule: trustedSchedule ?? null,
      installation: {
        executablePath: installation.executablePath,
        version: installation.version,
      },
      cwd,
      prompt,
      ...(promptSource ? { promptSource } : {}),
      onExitCommand: onExitCommand ?? null,
      model: definition.model,
      reasoningEffort: definition.reasoningEffort,
      fast: definition.fast ?? false,
      tokenLimit,
      stallTimeoutMs,
      lastProgressAtMs: Date.parse(streamStartedAt),
      lastRealProgressAtMs: Date.parse(streamStartedAt),
      steerReceiptCapable: true,
      startedAt: streamStartedAt,
      stream: openStream(),
      fallbackAttempt: fallbackAttempt ?? null,
      resumeProviderSessionId: providerSessionId ?? null,
    });
    if (fallbackClosed) {
      await cleanupFailedLaunch(runtimeSpawnError("daemon_closed", "Runtime spawner closed."));
      throw runtimeSpawnError("daemon_closed", "Runtime spawner closed.");
    }
    activeRuntimeHandles.set(runtimeSessionId, active);
    input.recordLifecycle?.({
      event: "runtime_spawn",
      runtimeSessionId,
      dispatchId: newDispatchId,
      ...(runtimeProcess.pid === undefined ? {} : { pid: runtimeProcess.pid }),
      ...readDispatchStageClock(),
    });
    if (!runtimeProcess.cloud)
      input.schedule(async () => {
        await publishRuntimeEvent(
          "runtime_session_liveness_changed",
          {
            runtimeSessionId,
            liveness: "live",
            ...(runtimeProcess.pid !== globalThis.process.pid &&
            Number.isSafeInteger(runtimeProcess.pid) &&
            runtimeProcess.pid > 1
              ? { processGroupPid: runtimeProcess.pid }
              : {}),
          },
          randomUUID(),
          binding,
        );
      }, activeBinding);
    // Attachment can refuse: a present workspace the liveness watcher cannot open is a real fault, not a
    // reason to run unwatched. The process is already launched, so the failed-launch path retires
    // it — terminate, release, and drop the stream — instead of leaving a live worker owned by a
    // dispatch this call is about to report as failed.
    try {
      attachActiveRuntime(extracted, active, resumeObservation);
    } catch (error) {
      await cleanupFailedLaunch(error);
      throw error;
    }
    return buildSpawnReceipt();
  }
  return {
    /** Host-only snapshot preparation; callers complete this before enqueueing admission. */
    prepareProgress: async (payload: JsonObject, worktree: TaskWorktreeCheckout | null) => {
      const resumedStream =
          typeof payload.dispatchId === "string" ? readDispatchStream(input.rootDir, payload.dispatchId) : null,
        inherited = resumedStream?.header.cwd,
        taskId = typeof payload.taskId === "string" ? payload.taskId : (resumedStream?.header.taskId ?? null),
        packageRoot = dispatchTaskPackageRoot(input, taskId, null),
        inheritedManagedRoots = managedRootsForTrustedCwd(input.rootDir, resumedStream?.header.trustedManagedCwd),
        { cwd } = resolveDispatchCwd(input.rootDir, payload, inherited, worktree, packageRoot, inheritedManagedRoots);
      return collectRuntimeWorkspaceProgress(cwd);
    },
    /** Checks a task dispatch's worktree out and prepares it; runs before the dispatch is queued for writing. */
    prepareWorktree: async (payload: JsonObject, reviewedCommit?: string | null) => {
      // Explicit-instance and declared-Agent model failures must surface before checkout/setup
      await preflightRuntimeSelection(input, payload);
      const taskId = payload.role === "reviewer" && typeof payload.taskId === "string" ? payload.taskId : null,
        pinnedCommit =
          taskId !== null && !input.remote
            ? reviewedCommit !== undefined
              ? reviewedCommit
              : reviewerPinnedCommit(
                  payload,
                  requireCurrentTaskProjection(requiredRuntimeProjection(input), taskId, "runtime.run").snapshot,
                )
            : undefined;
      return prepareDispatchWorktree(
        input,
        payload,
        readOnlyAttachDispatch(input, payload) ? () => null : projectedWorktreeBinding(input),
        pinnedCommit,
      );
    },
    /** Pre-collects reverse-trace Git history asynchronously before the dispatch enters the write slot. */
    prepareCausalGitHistory: (payload: JsonObject) =>
      prepareRuntimeCausalGitHistory({
        rootDir: input.rootDir,
        payload,
        projection: input.projection,
        remote: input.remote,
        runGitHistoryAsync: input.runGitHistoryAsync,
      }),
    spawnHandoff: (
      checkpoint: RuntimeHandoffCheckpoint,
      payload: JsonObject,
      binding: RuntimeBinding,
      worktree: TaskWorktreeCheckout | null = null,
      rollout?: Uint8Array,
      causalGitHistory?: GitHistoryPort | null,
    ) =>
      spawnAttempt(payload, binding, {
        preparedWorktree: worktree,
        handoff: checkpoint,
        handoffRollout: rollout,
        causalGitHistory,
      }),
    spawn: (
      payload: JsonObject,
      binding: RuntimeBinding,
      worktree: TaskWorktreeCheckout | null = null,
      recoveryRequested = false,
      options?: { readonly trustedDecisionReview?: boolean; readonly causalGitHistory?: GitHistoryPort | null },
    ) =>
      spawnAttempt(payload, binding, {
        preparedWorktree: worktree,
        recoveryRequested,
        trustedManagedCwd: options?.trustedDecisionReview === true ? "decision-package" : undefined,
        causalGitHistory: options?.causalGitHistory,
      }),
    /** The direct RepoCell runtime.run route owns admission and reuses its task projection read. */
    spawnTask: async (
      payload: JsonObject,
      binding: RuntimeBinding,
      worktree: TaskWorktreeCheckout | null = null,
      admissionProjection: ReturnType<typeof requiredRuntimeProjection>,
      workspaceProgress?: RuntimeWorkspaceProgress,
      causalGitHistory?: GitHistoryPort | null,
    ) => {
      const admitted = admitTaskDispatch({
        repoId: input.repoId,
        rootDir: input.rootDir,
        projection: admissionProjection,
        payload,
      });
      if (admitted.kind === "replay")
        return {
          ...runtimeSpawnReceipt(
            admitted.event,
            requiredRuntimeStore(input).publication(admitted.event),
            admitted.event.payload.runtimeSessionId,
            admitted.event.payload.dispatchId,
          ),
          recovery: admitted.recovery,
        } as unknown as JsonObject;
      const receipt = await spawnAttempt(admitted.payload, binding, {
        preparedWorktree: worktree,
        admissionTaskRead: admitted.taskRead,
        workspaceProgress,
        causalGitHistory,
        recoveryRequested: admitted.recovery !== null,
      });
      return admitted.recovery ? { ...receipt, recovery: { ...admitted.recovery, replayed: false } } : receipt;
    },
    spawnCoordinated: (
      payload: JsonObject,
      binding: RuntimeBinding,
      onPrepared?: (dispatchId: string, runtimeSessionId: string) => void,
    ) =>
      spawnAttempt(payload, binding, {
        publicationOwner: payload.targetAgentId === undefined ? "runtime" : "commander",
        onPrepared,
      }),
    spawnScheduled: (scheduled: TrustedScheduleSpawn, binding: RuntimeBinding) => {
      const agentPermissionMode = input.resolveAgent?.(scheduled.agentId)?.permissionMode,
        scheduledPermissionMode = resolveScheduledPermissionMode({
          ...(agentPermissionMode === undefined ? {} : { agentPermissionMode }),
          scheduleDefault: "bypass",
        });
      return spawnAttempt(
        {
          agentId: scheduled.agentId,
          prompt: scheduled.mission,
          dispatchKey: `${scheduled.scheduleId}:${scheduled.occurrenceId}:${scheduled.claimFence}`,
          cwd:
            scheduled.cwd === input.rootDir
              ? { scope: "repo-root" }
              : { scope: "repo-relative", path: path.relative(input.rootDir, scheduled.cwd) },
          ...(scheduled.effort ? { effort: scheduled.effort } : {}),
          ...(scheduled.fast === undefined ? {} : { fast: scheduled.fast }),
          // Honor declared Agent ceilings; only undeclared scheduled Agents take the headless bypass default.
          ...(agentPermissionMode === undefined ? { permissionMode: scheduledPermissionMode } : {}),
        },
        binding,
        { trustedSchedule: scheduled },
      );
    },
    /** The same trusted-schedule channel for a caller-assembled payload: a scheduled Squad run's
     * leader turns carry the squad decision protocol, so their spawn comes from the coordinator. */
    spawnScheduledCoordinated: (
      payload: JsonObject,
      scheduled: TrustedScheduleRuntime,
      binding: RuntimeBinding,
      onPrepared?: (dispatchId: string, runtimeSessionId: string) => void,
    ) => spawnAttempt(payload, binding, { trustedSchedule: scheduled, onPrepared }),
    adopt: (onProgress?: (completed: number) => void) => {
      input.schedule(() => sweepSettledRuntimeTempDirectories(extracted));
      return adoptRuntimes(extracted, onProgress);
    },
    cancel: (payload: JsonObject, binding: RuntimeBinding) => cancelRuntime(extracted, payload, binding),
    steer: (
      payload: JsonObject,
      binding: RuntimeBinding,
      options?: { readonly remoteControlRequestId?: string; readonly remoteControlOpId?: string },
    ) => steerRuntime(extracted, payload, binding, options),
    activeRuntimeSessionIds: (): readonly string[] => [...activeRuntimeHandles.keys()],
    activeRuntimeCount: (): number => activeRuntimeHandles.size,
    isRuntimeActive: (runtimeSessionId: string): boolean => {
      const runtimeHandles = activeRuntimeHandles;
      return runtimeHandles.has(runtimeSessionId);
    },
    activeDispatchId: (runtimeSessionId: string): string | null => {
      const runtimeHandles = activeRuntimeHandles;
      return runtimeHandles.get(runtimeSessionId)?.dispatchId ?? null;
    },
    activeRuntimeForSelector: (
      selector: { readonly dispatchId: string } | { readonly runtimeSessionId: string },
    ): { readonly runtimeSessionId: string; readonly dispatchId: string } | null => {
      const runtimeHandles = activeRuntimeHandles;
      if ("runtimeSessionId" in selector) {
        const active = runtimeHandles.get(selector.runtimeSessionId);
        return active ? { runtimeSessionId: active.runtimeSessionId, dispatchId: active.dispatchId } : null;
      }
      for (const active of runtimeHandles.values()) {
        if (active.dispatchId === selector.dispatchId)
          return { runtimeSessionId: active.runtimeSessionId, dispatchId: active.dispatchId };
      }
      return null;
    },
    flushPendingSteerReceipts: async (defaultBinding?: RuntimeBinding): Promise<void> => {
      const { flushAllPendingSteerReceipts } = await import("./runtime-spawn-active.ts");
      await flushAllPendingSteerReceipts(extracted, (id) => activeRuntimeHandles.get(id)?.binding, defaultBinding);
    },
    isIdle: () => activeRuntimeHandles.size === 0 && exiting.size === 0,
    close: () => {
      fallbackClosed = true;
      fallbackAbort.abort(new DOMException("Runtime spawner closed.", "AbortError"));
      if (ownsModelSlotQueue) modelSlotQueue.close();
      return closeRuntimes(extracted);
    },
  };
  async function publishRuntimeEvent<T extends RuntimeEventType>(
    type: T,
    payload: RuntimeEventOf<T>["payload"],
    opId: string,
    binding: RuntimeBinding,
    resultBody?: string,
    dispatchContext?: import("./fleet/command-protocol.ts").FleetRuntimeDispatchContext,
  ): Promise<{
    readonly event?: RuntimeEventOf<T>;
    readonly publication?: ReturnType<CanonicalEventStore["append"]>;
    readonly receipt?: JsonObject;
  }> {
    return publishRuntimeEventImpl<T>(extracted, type, payload, opId, binding, resultBody, dispatchContext);
  }
}
