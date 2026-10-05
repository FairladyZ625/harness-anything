import type { RuntimeHandoffCheckpoint } from "./runtime-handoff-store.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentRuntimeEventV1, CanonicalEventStore, SessionIdentity } from "@harness-anything/kernel";
import {
  consumeKnownError,
  runtimeDefinitionSnapshotArtifact,
  runtimeSessionIdFromActor,
  submissionDigest,
  type AuthorizationDecision,
} from "@harness-anything/kernel";
import { presetDocumentBody } from "@harness-anything/preset/internal/preset-resolver";
import { presetRuntimeDefaults, presetUserRoot } from "@harness-anything/preset/internal/preset-system";
import { agentRuntimeTargetForKind } from "./agent-runtime-contract.ts";
import { resolveAgentSkills } from "./agent-skills.ts";
import {
  archiveDispatchStream,
  openDispatchStream,
  readDispatchStream,
  reopenDispatchStream,
  removeDispatchStream,
  scrubProviderValue,
  type DispatchStreamWriter,
} from "./dispatch-stream.ts";
import { type JsonObject } from "./protocol/json-rpc-types.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { runtimePermissionMode } from "./runtime-permissions.ts";
import { scheduleMissionWithOutcomeProtocol } from "./schedule-runtime-outcome.ts";
import { dispatchCallbackRelay, removeRuntimeCallbackRelay } from "./runtime-callback-relay.ts";
import { cancelRuntime, closeRuntimes } from "./runtime-spawn-control.ts";
import { createActiveRuntime, attachActiveRuntime } from "./runtime-spawn-active.ts";
import { adoptRuntimes } from "./runtime-spawn-adoption.ts";
import {
  isRuntimeEvent,
  requiredRuntimeSpawnText,
  runtimeErrorMessage,
  runtimeSpawnError,
  runtimeTaskExecutionFrozenError,
  runtimeTaskLeaseRequiredMessage,
} from "./runtime-spawn-errors.ts";
import {
  assembleAgentPrompt,
  assembleUnboundPrompt,
  assembleScheduledMission,
  assembleTaskMission,
  missionAt,
  dispatchMissionForPermission,
  decisionReviewTarget as parseDecisionReviewTarget,
  resolveRuntimeInstanceId,
  runtimeMissionName,
  explicitPromptMission,
} from "./runtime-spawn-mission.ts";
import { assembleTaskCausalContext } from "./dispatch-causal-context.ts";
import {
  launchExitNotification,
  launchNative,
  launchRuntimeProcess,
  requiredRuntimeProjection,
  requiredRuntimeStore,
} from "./runtime-spawn-process.ts";
import { isStructuredSuccessResult, parseProviderFrame } from "./runtime-spawn-provider-frames.ts";
import {
  bindProvider as bindProviderImpl,
  captureErrorOutput as captureErrorOutputImpl,
  consumeProviderChunk,
  consumeProviderLine,
  markProtocolError as markProtocolErrorImpl,
  publishRuntimeEvent as publishRuntimeEventImpl,
} from "./runtime-spawn-provider-stream.ts";
import {
  applied as appliedImpl,
  controlReceipt as controlReceiptImpl,
  publishExit as publishExitImpl,
  runtimeResultText as runtimeResultTextImpl,
} from "./runtime-spawn-settlement.ts";
import { runtimeBindingForDispatch } from "./runtime-spawn-types.ts";
import { conventionalWorkerGitEnvironment } from "./runtime-worker-push.ts";
import type {
  ActiveRuntime,
  ResumeProcessObservation,
  RuntimeBinding,
  RuntimeSpawnerInput,
  RuntimeAttemptTerminal,
  RuntimeProcess,
  TrustedScheduleRuntime,
  TrustedScheduleSpawn,
} from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { runtimeDispatchRequestedPayload } from "./runtime-spawn-event.ts";
import { prepareBoundRuntimeLaunch, prepareTaskWorkerGitEnvironment } from "./runtime-spawn-context.ts";
import type { RuntimeEventOf, RuntimeEventType, RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { assertReviewerTarget, selectReviewTarget } from "./review-dispatch-admission.ts";
import {
  continuationMission,
  initialFallbackAttempt,
  requiredRuntimeFast,
  settleFallbackAttempt,
} from "./runtime-spawn-fallback.ts";
import {
  resolveRuntimeResume,
  assertNativeResumeNotExported,
  assertRuntimeHandoffLaunch,
  assertResumeAgent,
  prepareDispatchWorktree,
  projectedWorktreeBinding,
  resolveDispatchCwd,
} from "./runtime-resume-admission.ts";
import { taskWorktreeCheckoutNote, verifyHandoffWorktree, type TaskWorktreeCheckout } from "./task-worktree.ts";
import { assertTaskDispatchPrerequisites, taskDispatchLeaseQualifies } from "./task-dispatch-admission.ts";
import { workerLedgerPath } from "./worktree-setup.ts";
export const resultMediaType = "text/plain; charset=utf-8" as const,
  providerErrorLimit = 64 * 1024,
  resumeAdmissionTimeoutMs = 30_000,
  exitNotificationTimeoutMs = 30_000;
export function makeRuntimeSpawner(input: RuntimeSpawnerInput) {
  const processes = new Map<string, ActiveRuntime>(),
    exiting = new Set<string>(),
    launch = input.launch ?? launchNative,
    prepareWorkerGitEnvironment = (instanceId: string) => prepareTaskWorkerGitEnvironment(input, instanceId);
  let fallbackClosed = false;
  const extracted: RuntimeSpawnerContext = {
    input,
    requiredRuntimeStore,
    requiredRuntimeProjection,
    runtimeSpawnError,
    consumeChunk,
    consumeLine,
    markProtocolError,
    parseProviderFrame,
    bindProvider,
    isStructuredSuccessResult,
    processes,
    providerErrorLimit,
    publishRuntimeEvent,
    exiting,
    runtimeResultText,
    resultMediaType,
    launchExitNotification,
    publishExit,
    controlReceipt,
    captureErrorOutput,
    prepareWorkerGitEnvironment,
    settleFallback,
    reconcileFallback,
  };
  const spawnAttempt = async (
    payload: JsonObject,
    binding: RuntimeBinding,
    inheritedFallback?: RuntimeFallbackAttempt,
    trustedSchedule?: TrustedScheduleRuntime,
    handoffFromRuntimeSessionId?: string,
    publicationOwner: ActiveRuntime["publicationOwner"] = "runtime",
    preparedWorktree: TaskWorktreeCheckout | null = null,
    handoff?: RuntimeHandoffCheckpoint,
  ): Promise<JsonObject> => {
    const dryRun = payload.dryRun === true;
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
      effort = payload.effort === undefined ? undefined : requiredRuntimeSpawnText(payload.effort, "effort"),
      fast = payload.fast === undefined ? undefined : requiredRuntimeFast(payload.fast),
      permissionMode =
        payload.permissionMode === undefined
          ? (inherited?.permissionMode ?? undefined)
          : requiredRuntimeSpawnText(payload.permissionMode, "permissionMode"),
      promptSource =
        payload.promptSource === undefined ? undefined : requiredRuntimeSpawnText(payload.promptSource, "promptSource"),
      onExitCommand =
        payload.onExitCommand === undefined
          ? undefined
          : requiredRuntimeSpawnText(payload.onExitCommand, "onExitCommand"),
      idempotencyKey = requiredRuntimeSpawnText(payload.idempotencyKey, "idempotencyKey"),
      taskId =
        payload.taskId === null || payload.taskId === undefined
          ? (inherited?.taskId ?? null)
          : requiredRuntimeSpawnText(payload.taskId, "taskId"),
      requestedExecutionId =
        payload.executionId === undefined ? undefined : requiredRuntimeSpawnText(payload.executionId, "executionId"),
      decisionReviewTarget = parseDecisionReviewTarget(payload.reviewTarget),
      providerSessionId =
        typeof payload.providerSessionId === "string"
          ? requiredRuntimeSpawnText(payload.providerSessionId, "providerSessionId")
          : (handoff?.providerSessionId ?? resumed?.providerSessionId);
    assertResumeAgent(requestedDispatchId, inherited?.agentId, payload.agentId, agentId);
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
            )
          : null,
      { cwd, worktree: dispatchWorktree } = resolveDispatchCwd(
        input.rootDir,
        payload,
        inherited?.cwd,
        remoteTask
          ? await prepareDispatchWorktree(
              input,
              { ...payload, ...(handoff ? { taskId: handoff.taskId, acceptedCommit: handoff.commit } : {}) },
              () => remoteTask.worktree,
            )
          : preparedWorktree,
      ),
      store = input.remote ? null : requiredRuntimeStore(input),
      projection = input.remote ? null : requiredRuntimeProjection(input);
    const reviewerBinding = role === "reviewer";
    assertReviewerTarget({
      reviewer: reviewerBinding,
      taskId,
      decisionTarget: decisionReviewTarget,
      executionId: requestedExecutionId,
      remoteExecutionId: remoteTask?.executionId,
      remote: input.remote !== undefined,
    });
    // Every local spawn (runtime.run, squad turns, fallback continuations) runs in the RepoCell write queue.
    const taskSnapshot =
        taskId && !input.remote ? requireCurrentTaskProjection(projection!, taskId, "runtime.run").snapshot : null,
      leaseAtAdmission = taskId && !input.remote ? projection!.currentLease(taskId) : null,
      // A reviewer dispatch binds to the submitted cut under review — never to the task's active
      // implementation execution or lease — so it cannot observe, open, or mutate an implementation
      // iteration. Selection happens here so every entry (task dispatch-review, completion facade)
      // enforces the same invariant.
      reviewTarget =
        reviewerBinding && decisionReviewTarget === null
          ? selectReviewTarget(taskId, requestedExecutionId, taskSnapshot, input.remote != null)
          : null,
      hash = createHash("sha256").update(`${input.repoId}\0${idempotencyKey}`).digest("hex"),
      newDispatchId = `dispatch_${hash.slice(0, 24)}`,
      runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
      dispatchOpId = `runtime-spawn-${hash.slice(0, 32)}`,
      trustedHandoffSource = handoffFromRuntimeSessionId ?? resumed?.header.runtimeSessionId ?? null;
    const authorizationDecision: AuthorizationDecision | null = binding.authorizationDecision ?? null;
    if (taskId && !input.remote && !reviewerBinding) {
      const leaseQualifies = taskDispatchLeaseQualifies(
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
      if (!dryRun) assertTaskDispatchPrerequisites(projection!, taskId);
      // A submitted round's cut is frozen: an implementation runtime dispatched now could never
      // write under its lease, so the conflict is rejected here instead of after the work is done.
      const frozenStatus = taskSnapshot?.task?.status;
      if (!dryRun && (frozenStatus === "submitted" || frozenStatus === "in_review"))
        throw runtimeTaskExecutionFrozenError(taskId, frozenStatus);
      if (!dryRun && !leaseQualifies)
        throw runtimeSpawnError(
          "runtime_task_lease_required",
          runtimeTaskLeaseRequiredMessage(taskId, leaseAtAdmission),
        );
    }
    const daemonRoute = taskId || trustedSchedule || reviewerBinding ? input.runtimeDaemonRoute : undefined;
    if ((taskId || trustedSchedule || reviewerBinding) && !daemonRoute)
      throw runtimeSpawnError(
        "runtime_preconditions_unavailable",
        "Task-bound and scheduled runtime spawn require a sealed daemon route before dispatch.",
      );
    const causalContext =
        remoteTask === null
          ? taskId === null
            ? null
            : assembleTaskCausalContext({ projection: projection!, taskId })
          : remoteTask.causalContext,
      taskMission = taskId
        ? missionAt(input.rootDir, cwd, remoteTask ?? { projection: projection!, taskId, missionName, causalContext })
        : null,
      mission =
        explicitMission === undefined
          ? (taskMission?.mission ?? requiredRuntimeSpawnText(undefined, "prompt"))
          : explicitPromptMission(taskId, causalContext, explicitMission);
    const remoteExisting = input.remote ? await input.remote.existing(dispatchOpId) : null,
      existing = input.remote ? null : store!.readEvent(dispatchOpId);
    if (!dryRun && remoteExisting)
      return {
        ...remoteExisting,
        ...(handoff ? { replayed: true } : {}),
        runtimeSessionId,
        dispatchId: newDispatchId,
        authorizationDecision: authorizationDecision as unknown as JsonObject | null,
      };
    if (!dryRun && existing) {
      if (!isRuntimeEvent(existing) || existing.type !== "runtime_dispatch_requested")
        throw runtimeSpawnError(
          "runtime_dispatch_conflict",
          `Dispatch opId ${dispatchOpId} belongs to another canonical event.`,
        );
      return {
        ...applied(existing, store!.publication(existing), runtimeSessionId, newDispatchId),
        ...(handoff ? { replayed: true } : {}),
        authorizationDecision: authorizationDecision as unknown as JsonObject | null,
      };
    }
    const runtimeActor = `agent:runtime-session:${runtimeSessionId}`,
      squad =
        squadId || targetAgentId
          ? (input.resolveSquadDispatch?.(squadId, agentId!, targetAgentId) ??
            (() => {
              if (squadId) throw runtimeSpawnError("squad_not_found", `Squad ${squadId} is unavailable.`);
              throw runtimeSpawnError(
                "squad_member_not_found",
                `Agent ${targetAgentId} is not available in a squad led by ${agentId}.`,
              );
            })())
          : null,
      delegatedBy = squad?.worker ? squad.leader : null,
      agent =
        squad?.worker ??
        squad?.leader ??
        (agentId
          ? (input.resolveAgent?.(agentId) ??
            (() => {
              throw runtimeSpawnError("agent_not_found", `Agent ${agentId} is unavailable.`);
            })())
          : null),
      resolvedSkills = (agent ? resolveAgentSkills({ rootDir: input.rootDir, skills: agent.skills }) : []).map(
        (skill) => ({ ...skill, skillFile: workerLedgerPath(input.rootDir, cwd, skill.skillFile) }),
      ),
      preset = agent?.preset
        ? (() => {
            if (!input.readSettings)
              throw runtimeSpawnError(
                "settings_projection_unavailable",
                "Agent preset resolution requires the repository Settings projection.",
              );
            const defaults = presetRuntimeDefaults(input.readSettings());
            // The spawn prompt needs the preset's PRESET.md text only; a full resolve would
            // re-hash the whole catalog for a body the catalog already decoded.
            return presetDocumentBody({
              userRoot: presetUserRoot(input.rootDir),
              verticalId: defaults.verticalId,
              presetId: agent.preset!,
            });
          })()
        : undefined,
      runtimeSessions = input.remote ? await input.remote.readRuntimeSessions() : projection!.readRuntimeSessions(),
      runtimeInstances = input.runtimeInstances?.() ?? [],
      fallbackAttempt =
        inheritedFallback ??
        initialFallbackAttempt(
          agent,
          explicitRuntimeInstanceId,
          model,
          providerSessionId,
          idempotencyKey,
          mission,
          runtimeInstances,
          runtimeSessions,
        ),
      fallbackCandidate = fallbackAttempt?.candidates[fallbackAttempt.attemptIndex],
      runtimeInstanceId = await resolveRuntimeInstanceId({
        requested: fallbackCandidate?.instance ?? explicitRuntimeInstanceId ?? agent?.instance,
        providerSessionId: providerSessionId ?? undefined,
        agent,
        model,
        instances: runtimeInstances,
        sessions: runtimeSessions,
      }),
      runtimeInstance = runtimeInstances.find((instance) => instance.instanceId === runtimeInstanceId),
      // Model resolution order: --model override > the runtimes row matching the selected
      // instance's kind > the instance default (undefined defers to prepareLaunch).
      selectedModel =
        fallbackCandidate?.model ??
        model ??
        (agent && runtimeInstance
          ? agentRuntimeTargetForKind(agent.runtimes, runtimeInstance.kindId)?.model
          : undefined),
      configuredPermissionMode = runtimeInstance?.permissionMode ?? undefined,
      declaredPermissionMode = permissionMode ?? agent?.permissionMode,
      effectivePermissionMode = declaredPermissionMode ?? configuredPermissionMode,
      callbackRelay = dispatchCallbackRelay(
        input.rootDir,
        newDispatchId,
        daemonRoute,
        runtimeInstance,
        effectivePermissionMode,
      ),
      missionDaemonRoute =
        callbackRelay && daemonRoute ? { userRoot: "", daemonId: "", endpoint: callbackRelay.path } : daemonRoute,
      selfContainedMission =
        taskMission && daemonRoute
          ? assembleTaskMission({
              mission,
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
      dispatchMission = dispatchMissionForPermission(selfContainedMission ?? mission, effectivePermissionMode),
      assembledPrompt = agent
        ? assembleAgentPrompt(role === "reviewer" ? { ...agent, role } : agent, dispatchMission, preset, resolvedSkills)
        : taskMission || role === "reviewer"
          ? assembleUnboundPrompt(dispatchMission, role === "reviewer" ? role : undefined)
          : dispatchMission,
      prompt = trustedSchedule ? scheduleMissionWithOutcomeProtocol(assembledPrompt) : assembledPrompt;
    // Dry-run preview ends exactly at the launch boundary: the same inputs, same
    // assembly calls, no prepareLaunch, no dispatch event, no lease handoff.
    if (dryRun)
      return {
        schema: "agent-dispatch-preview/v1",
        ok: true,
        command: "runtime-spawn",
        dispatchId: newDispatchId,
        runtimeSessionId,
        prompt,
        mission,
      };
    const prepared = await input.prepareLaunch(runtimeInstanceId, {
        cwd,
        prompt,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(effort ? { effort } : {}),
        ...(fast === undefined ? {} : { fast }),
        ...(declaredPermissionMode ? { permissionMode: declaredPermissionMode } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
      }),
      definition = prepared.definition,
      installation = prepared.installation,
      declaredKindId = runtimeKindForId(definition.kindId).kindId,
      launchedPermissionMode = runtimePermissionMode(effectivePermissionMode, declaredKindId);
    if (declaredKindId === "zcode" && launchedPermissionMode !== "bypass")
      throw runtimeSpawnError(
        "zcode_unattended_permission_mode_unsupported",
        [
          "ZCode edit and plan modes require an interactive permission client and cannot run unattended. ",
          `Set permissionMode to bypass in Agent ${agent?.id ?? "declaration"}.`,
        ].join(""),
      );
    if (
      definition.instanceId !== runtimeInstanceId ||
      (runtimeInstance !== undefined && runtimeInstance.kindId !== definition.kindId) ||
      definition.installationId !== installation.installationId ||
      definition.kindId !== installation.kindId ||
      prepared.executablePath !== installation.executablePath ||
      prepared.cwd !== cwd ||
      prepared.prompt !== prompt
    )
      throw runtimeSpawnError(
        "invalid_runtime_launch",
        "Prepared runtime launch does not match the closed spawn request.",
      );
    const definitionArtifact = runtimeDefinitionSnapshotArtifact(definition),
      definitionSnapshotRef = definitionArtifact.ref,
      runtimeKind = runtimeKindForId(definition.kindId),
      protocolFamily = runtimeKind.protocolFamily,
      workerGitEnvironment = taskId
        ? await prepareWorkerGitEnvironment(runtimeInstanceId)
        : trustedSchedule?.mode === "remediate"
          ? await input.prepareWorkerGitEnvironment?.(runtimeInstanceId)
          : undefined,
      workerIdentityEnvironment =
        taskId || trustedSchedule || reviewerBinding ? await conventionalWorkerGitEnvironment(input.rootDir) : {};
    if (handoff) await verifyHandoffWorktree(cwd, handoff.commit);
    // Every implementation runtime, including squad leaders, takes the actual lease.
    const taskLeaseHandoff = taskId && !input.remote && !reviewerBinding ? input.handoffTaskLease : undefined,
      activeBinding = taskLeaseHandoff
        ? await taskLeaseHandoff({
            taskId: taskId!,
            runtimeSessionId,
            fromRuntimeSessionId: trustedHandoffSource,
            binding,
          })
        : binding;
    const lease = taskId && !input.remote ? projection!.currentLease(taskId) : null;
    if (
      taskId &&
      taskLeaseHandoff &&
      (lease?.phase !== "held" || lease.actor.executor?.id !== `runtime-session:${runtimeSessionId}`)
    )
      throw runtimeSpawnError("runtime_task_lease_required", runtimeTaskLeaseRequiredMessage(taskId, lease));
    const taskBinding = taskId
        ? {
            taskId,
            executionId: remoteTask?.executionId ?? (reviewerBinding ? reviewTarget!.executionId : lease!.executionId),
            // A reviewer holds no lease; carrying another executor's leaseVersion would misstate
            // the session's write authority in every downstream binding check.
            leaseVersion: reviewerBinding ? null : (lease?.version ?? null),
          }
        : null,
      streamStartedAt = input.now();
    let process: RuntimeProcess | undefined;
    let resumeObservation: ResumeProcessObservation | undefined;
    let stream: DispatchStreamWriter | undefined;
    const openStream = (): DispatchStreamWriter =>
      (stream ??= openDispatchStream(input.rootDir, {
        dispatchId: newDispatchId,
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
        ...(typeof taskBinding?.leaseVersion === "number" ? { leaseVersion: taskBinding.leaseVersion } : {}),
        ...(trustedSchedule ? { schedule: trustedSchedule } : {}),
        runtimeSessionId,
        instanceId: definition.instanceId,
        startedAt: streamStartedAt,
        dispatchOpId,
        kindId: definition.kindId,
        permissionMode: launchedPermissionMode ?? null,
        binding: runtimeBindingForDispatch(activeBinding),
        cwd,
        prompt: scrubProviderValue(prompt) as string,
        mission: scrubProviderValue(mission) as string,
        ...(fallbackAttempt ? { fallbackAttempt } : {}),
        ...(promptSource ? { promptSource } : {}),
        model: definition.model,
        reasoningEffort: definition.reasoningEffort,
        fast: definition.fast ?? false,
        resumeProviderSessionId: providerSessionId ?? null,
        ...(handoffEnabled ? { handoffEnabled: true } : {}),
        ...(handoff
          ? { resumedFromDispatchId: handoff.dispatchId }
          : requestedDispatchId
            ? { resumedFromDispatchId: requestedDispatchId }
            : {}),
        ...(onExitCommand ? { onExitCommand } : {}),
        ...(role ? { role } : {}),
        ...(agent ? { agentId: agent.id, agentName: agent.name } : {}),
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
    assertRuntimeHandoffLaunch(
      handoffEnabled,
      handoff,
      { taskId, agentId, role, trustedSchedule },
      definition.kindId,
      installation.version,
    );
    const cleanupFailedLaunch = async (error: unknown): Promise<void> => {
      process?.terminate();
      process?.release?.();
      cleanupCallbackRelay();
      if (stream) removeDispatchStream(input.rootDir, newDispatchId);
      if (!taskLeaseHandoff || !taskBinding) return;
      await input.onAttemptTerminal?.({
        runtimeSessionId,
        dispatchId: newDispatchId,
        task: taskBinding,
        schedule: trustedSchedule ?? null,
        outcome: "failed",
        reason: `Runtime dispatch failed before provider registration: ${runtimeErrorMessage(error)}`,
        endedAt: input.now(),
        resultRef: null,
        binding: activeBinding,
      });
    };
    const cleanupCallbackRelay = (): void => {
      if (callbackRelay) removeRuntimeCallbackRelay(input.rootDir, newDispatchId);
    };
    const launchPreparedProcess = async () => {
      const workerLaunch = await prepareBoundRuntimeLaunch({
        input,
        prepared,
        daemonRoute,
        callbackRelay,
        workerGitEnvironment,
        workerIdentityEnvironment,
        runtimeActor,
        taskId,
        trustedSchedule,
        reviewerBinding: Boolean(reviewerBinding),
        ...(taskId
          ? {
              execution: {
                repoId: input.repoId,
                personId: activeBinding.actor.principal.personId,
                source: activeBinding.source,
                runtimeSessionId,
                dispatchId: newDispatchId,
                taskId,
                executionId: taskBinding!.executionId,
                role: reviewerBinding ? "reviewer" : "implementation",
              },
            }
          : {}),
      });
      return launchRuntimeProcess(
        launch,
        workerLaunch,
        {
          rootDir: input.rootDir,
          dispatchId: newDispatchId,
          ...(callbackRelay ? { callbackRelay } : {}),
        },
        providerSessionId,
      );
    };
    // Remote resumes must first win center admission, just like fresh provider launches.
    if (providerSessionId && !input.remote && !handoff) {
      if (!requestedDispatchId) assertNativeResumeNotExported(input.rootDir, providerSessionId, projection!);
      try {
        openStream();
        ({ process, resumeObservation } = await launchPreparedProcess());
      } catch (error) {
        await cleanupFailedLaunch(error);
        throw error;
      }
    }
    let requested!: Awaited<ReturnType<typeof publishRuntimeEvent>>;
    try {
      await publishRuntimeEvent(
        "runtime_installation_observed",
        {
          installationId: installation.installationId,
          kindId: installation.kindId,
          protocolFamily,
          hostRef: "host:local",
          version: installation.version,
          discoverySource: "wrapper",
          capabilities: runtimeKind.declaredCapabilities,
        },
        `${dispatchOpId}-installation`,
        binding,
      );
      requested = await publishRuntimeEvent(
        "runtime_dispatch_requested",
        runtimeDispatchRequestedPayload(
          {
            dispatchId: newDispatchId,
            runtimeSessionId,
            instanceId: definition.instanceId,
            installationId: definition.installationId,
            kindId: definition.kindId,
            idempotencyKey,
            definitionSnapshotRef,
            definitionSnapshot: definition,
            startedAt: streamStartedAt,
            ...(handoffEnabled ? { handoffEnabled: true } : {}),
            ...(providerSessionId ? { resumeProviderSessionId: providerSessionId } : {}),
            ...(handoff ? { handoffCheckpointId: handoff.dispatchId, acceptedCommit: handoff.commit } : {}),
          },
          {
            ...(handoff
              ? { resumedFromDispatchId: handoff.dispatchId }
              : requestedDispatchId
                ? { resumedFromDispatchId: requestedDispatchId }
                : {}),
            ...(taskBinding ? { taskBinding } : {}),
            attemptGroupId: fallbackAttempt?.attemptGroupId ?? newDispatchId,
            attemptIndex: fallbackAttempt?.attemptIndex ?? 0,
            ...(agent ? { agent } : {}),
            ...(squad ? { squadId: squad.squadId } : {}),
            cwd,
            ...(role ? { role } : {}),
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
          role: role ?? null,
          taskId: taskBinding?.taskId ?? null,
          executionId: taskBinding?.executionId ?? null,
        },
      );
    } catch (error) {
      await cleanupFailedLaunch(error);
      throw error;
    }
    // The center queue owns the claim: another edge can win after our initial receipt read.
    if (input.remote && requested.receipt?.replayed === true) {
      cleanupCallbackRelay();
      return {
        ...requested.receipt,
        runtimeSessionId,
        dispatchId: newDispatchId,
        authorizationDecision: authorizationDecision as unknown as JsonObject | null,
      };
    }
    // Publish the canonical session before starting the provider. A provider can
    // immediately call back through the sealed daemon route; its task+dispatch
    // target must see a session projection before that first callback arrives.
    try {
      await publishRuntimeEvent(
        "runtime_session_started",
        {
          runtimeSessionId,
          instanceId: definition.instanceId,
          installationId: definition.installationId,
          kindId: definition.kindId,
          definitionSnapshotRef,
          launchGeneration: input.daemonGeneration,
          attachable: true,
          ...(taskBinding ? { taskBinding: { taskId: taskBinding.taskId, executionId: taskBinding.executionId } } : {}),
        },
        `${dispatchOpId}-started`,
        binding,
      );
    } catch (error) {
      await cleanupFailedLaunch(error);
      throw error;
    }
    if (!process)
      try {
        openStream();
        ({ process, resumeObservation } = await launchPreparedProcess());
      } catch (error) {
        await cleanupFailedLaunch(error);
        await publishRuntimeEvent(
          "runtime_dispatch_outcome_unknown",
          { dispatchId: newDispatchId, runtimeSessionId },
          `${dispatchOpId}-outcome-unknown`,
          binding,
        );
        throw error;
      }
    const runtimeProcess = process;
    const active = createActiveRuntime({
      process: runtimeProcess,
      dispatchId: newDispatchId,
      runtimeSessionId,
      dispatchOpId,
      instanceId: definition.instanceId,
      kindId: definition.kindId,
      permissionMode: launchedPermissionMode ?? null,
      agent,
      role: role ?? null,
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
      startedAt: streamStartedAt,
      stream: openStream(),
      fallbackAttempt: fallbackAttempt ?? null,
      resumeProviderSessionId: providerSessionId ?? null,
    });
    processes.set(runtimeSessionId, active);
    input.recordLifecycle?.({
      event: "runtime_spawn",
      runtimeSessionId,
      dispatchId: newDispatchId,
      pid: runtimeProcess.pid,
    });
    // `runtime_session_started` is published before launch so immediate provider
    // callbacks can resolve the session. Confirm liveness after the process is
    // actually registered, ahead of any output or exit work those callbacks queue.
    input.schedule(async () => {
      await publishRuntimeEvent(
        "runtime_session_liveness_changed",
        { runtimeSessionId, liveness: "live" },
        `${dispatchOpId}-live`,
        binding,
      );
    }, activeBinding);
    attachActiveRuntime(extracted, active, resumeObservation);
    return requested.receipt
      ? {
          ...requested.receipt,
          runtimeSessionId,
          dispatchId: newDispatchId,
          ...(readOnlyDispatch ? { ledgerAccess: "unavailable", reportDelivery: "stdout" } : {}),
          authorizationDecision: authorizationDecision as unknown as JsonObject | null,
        }
      : {
          ...applied(requested.event, requested.publication!, runtimeSessionId, newDispatchId),
          ...(readOnlyDispatch ? { ledgerAccess: "unavailable", reportDelivery: "stdout" } : {}),
          authorizationDecision: authorizationDecision as unknown as JsonObject | null,
        };
  };
  return {
    /** Checks a task dispatch's worktree out and prepares it; runs before the dispatch is queued for writing. */
    prepareWorktree: (payload: JsonObject) => prepareDispatchWorktree(input, payload, projectedWorktreeBinding(input)),
    spawnHandoff: (
      checkpoint: RuntimeHandoffCheckpoint,
      payload: JsonObject,
      binding: RuntimeBinding,
      worktree: TaskWorktreeCheckout | null = null,
    ) => spawnAttempt(payload, binding, undefined, undefined, undefined, "runtime", worktree, checkpoint),
    spawn: (payload: JsonObject, binding: RuntimeBinding, worktree: TaskWorktreeCheckout | null = null) =>
      spawnAttempt(payload, binding, undefined, undefined, undefined, "runtime", worktree),
    spawnCoordinated: (payload: JsonObject, binding: RuntimeBinding) =>
      spawnAttempt(
        payload,
        binding,
        undefined,
        undefined,
        undefined,
        payload.targetAgentId === undefined ? "runtime" : "commander",
      ),
    spawnScheduled: (scheduled: TrustedScheduleSpawn, binding: RuntimeBinding) =>
      spawnAttempt(
        {
          runtimeInstanceId: scheduled.runtimeInstanceId,
          agentId: scheduled.agentId,
          prompt: scheduled.mission,
          idempotencyKey: `${scheduled.scheduleId}:${scheduled.claimFence}`,
          cwd:
            scheduled.cwd === input.rootDir
              ? { scope: "repo-root" }
              : { scope: "repo-relative", path: path.relative(input.rootDir, scheduled.cwd) },
          ...(scheduled.model ? { model: scheduled.model } : {}),
          ...(scheduled.effort ? { effort: scheduled.effort } : {}),
          ...(scheduled.fast === undefined ? {} : { fast: scheduled.fast }),
          // Narrower modes refuse every shell call headless; detect states its no-write boundary in the mission.
          permissionMode: "bypass",
        },
        binding,
        undefined,
        scheduled,
        undefined,
      ),
    adopt: (onProgress?: (completed: number) => void) => adoptRuntimes(extracted, onProgress),
    cancel: (payload: JsonObject, binding: RuntimeBinding) => cancelRuntime(extracted, payload, binding),
    close: () => {
      fallbackClosed = true;
      closeRuntimes(extracted);
    },
  };
  async function publishRuntimeEvent<T extends RuntimeEventType>(
    type: T,
    payload: RuntimeEventOf<T>["payload"],
    opId: string,
    binding: RuntimeBinding,
    resultBody?: string,
    dispatchContext?: import("./fleet/contract.ts").FleetRuntimeDispatchContext,
  ): Promise<{
    readonly event: RuntimeEventOf<T>;
    readonly publication?: ReturnType<CanonicalEventStore["append"]>;
    readonly receipt?: JsonObject;
  }> {
    return publishRuntimeEventImpl<T>(extracted, type, payload, opId, binding, resultBody, dispatchContext);
  }
  async function consumeChunk(active: ActiveRuntime, chunk: string, flush: boolean, persisted = false): Promise<void> {
    return consumeProviderChunk(extracted, active, chunk, flush, persisted);
  }
  async function consumeLine(
    active: ActiveRuntime,
    line: string,
    persisted = false,
    publishSignals = true,
  ): Promise<void> {
    return consumeProviderLine(extracted, active, line, persisted, publishSignals);
  }
  function captureErrorOutput(active: ActiveRuntime, chunk: string): void {
    return captureErrorOutputImpl(extracted, active, chunk);
  }
  async function bindProvider(active: ActiveRuntime, identity: SessionIdentity): Promise<void> {
    return bindProviderImpl(extracted, active, identity);
  }
  function markProtocolError(active: ActiveRuntime): void {
    return markProtocolErrorImpl(extracted, active);
  }
  async function publishExit(active: ActiveRuntime, code: number | null, resumePublishedExit = false): Promise<void> {
    return publishExitImpl(extracted, active, code, resumePublishedExit);
  }
  function runtimeResultText(
    active: ActiveRuntime,
    code: number | null,
    outcome: "succeeded" | "failed" | "unknown" | "cancelled",
  ): string {
    return runtimeResultTextImpl(extracted, active, code, outcome);
  }
  function applied(
    event: AgentRuntimeEventV1,
    publication: ReturnType<CanonicalEventStore["publication"]>,
    runtimeSessionId: string,
    dispatchId: string,
  ) {
    return appliedImpl(extracted, event, publication, runtimeSessionId, dispatchId);
  }
  function controlReceipt(opId: string, runtimeSessionId: string, detail?: string) {
    return controlReceiptImpl(extracted, opId, runtimeSessionId, detail);
  }
  async function settleFallback(
    active: ActiveRuntime,
    outcome: RuntimeAttemptOutcome,
    terminal: RuntimeAttemptTerminal,
  ): Promise<void> {
    return settleFallbackAttempt(extracted, active, outcome, terminal);
  }
  function reconcileFallback(stream: ReturnType<typeof readDispatchStream>): void {
    if (
      fallbackClosed ||
      !stream ||
      stream.fallbackState !== "scheduled" ||
      !stream.fallbackSchedule ||
      !stream.attemptOutcome ||
      !stream.header.fallbackAttempt ||
      !stream.header.binding ||
      typeof stream.header.cwd !== "string"
    )
      return;
    const notBeforeMs = Date.parse(stream.fallbackSchedule.notBeforeAt),
      observedNowMs = Date.parse(input.now());
    if (!Number.isFinite(notBeforeMs) || !Number.isFinite(observedNowMs)) return;
    const remainingMs = Math.max(0, notBeforeMs - observedNowMs);
    const timer = setTimeout(() => {
      if (fallbackClosed) return;
      input.schedule(async () => {
        const current = readDispatchStream(input.rootDir, stream.header.dispatchId);
        if (
          !current ||
          current.fallbackState !== "scheduled" ||
          current.fallbackSchedule?.notBeforeAt !== stream.fallbackSchedule!.notBeforeAt ||
          !current.attemptOutcome ||
          !current.header.fallbackAttempt ||
          !current.header.binding ||
          typeof current.header.cwd !== "string"
        )
          return;
        const header = current.header,
          binding = runtimeBindingForDispatch(header.binding!),
          dispatchCwd = header.cwd;
        if (!binding || typeof dispatchCwd !== "string") return;
        const fallback = header.fallbackAttempt!,
          nextAttemptIndex = fallback.attemptIndex + 1,
          nextFallback = { ...fallback, attemptIndex: nextAttemptIndex },
          next = fallback.candidates[nextAttemptIndex],
          writer = reopenDispatchStream(input.rootDir, header),
          continuation = continuationMission(current.attemptOutcome, fallback.originalMission);
        if (
          !next ||
          next.instance !== current.fallbackSchedule.nextProvider.instance ||
          next.model !== current.fallbackSchedule.nextProvider.model
        )
          return;
        try {
          const continuationPayload: JsonObject = {
              runtimeInstanceId: next.instance,
              ...(header.delegatedByAgentId && header.agentId
                ? { agentId: header.delegatedByAgentId, targetAgentId: header.agentId }
                : header.agentId
                  ? { agentId: header.agentId }
                  : {}),
              ...(header.role ? { role: header.role } : {}),
              ...(header.squadId ? { squadId: header.squadId } : {}),
              ...(header.parentRuntimeSessionId ? { parentRuntimeSessionId: header.parentRuntimeSessionId } : {}),
              ...(next.model ? { model: next.model } : {}),
              ...(header.reasoningEffort ? { effort: header.reasoningEffort } : {}),
              ...(header.fast === undefined ? {} : { fast: header.fast }),
              ...(header.permissionMode ? { permissionMode: header.permissionMode } : {}),
              cwd:
                dispatchCwd === input.rootDir
                  ? { scope: "repo-root" }
                  : { scope: "repo-relative", path: path.relative(input.rootDir, dispatchCwd) },
              prompt: continuation,
              ...(header.promptSource ? { promptSource: header.promptSource } : {}),
              ...(header.onExitCommand ? { onExitCommand: header.onExitCommand } : {}),
              ...(header.taskId ? { taskId: header.taskId } : {}),
              idempotencyKey: `${fallback.rootIdempotencyKey}:fallback:${String(nextAttemptIndex)}`,
            },
            continuationBinding =
              (await input.authorizeRuntimeContinuation?.(
                continuationPayload,
                binding,
                `runtime-continuation:${header.dispatchId}:${nextAttemptIndex}`,
              )) ?? binding;
          const receipt = await spawnAttempt(
            continuationPayload,
            continuationBinding,
            nextFallback,
            header.schedule,
            header.runtimeSessionId,
            header.publicationOwner,
          );
          writer.appendFallbackState(
            {
              state: "dispatched",
              nextDispatchId: String(receipt.dispatchId),
              nextRuntimeSessionId: String(receipt.runtimeSessionId),
            },
            input.now(),
          );
          archiveDispatchStream(input.rootDir, header.dispatchId);
        } catch (error) {
          consumeKnownError(error);
          const reason = `Provider fallback could not launch ${next.instance}: ${runtimeErrorMessage(error)}`;
          writer.appendFallbackState({ state: "exhausted", reason }, input.now());
          archiveDispatchStream(input.rootDir, header.dispatchId);
          await input.onAttemptTerminal?.({
            runtimeSessionId: header.runtimeSessionId,
            dispatchId: header.dispatchId,
            task:
              header.taskId && header.executionId
                ? {
                    taskId: header.taskId,
                    executionId: header.executionId,
                    leaseVersion: header.leaseVersion ?? null,
                  }
                : null,
            schedule: header.schedule ?? null,
            outcome: "failed",
            reason,
            endedAt: input.now(),
            resultRef: null,
            binding,
          });
        }
      }, runtimeBindingForDispatch(stream.header.binding!));
    }, remainingMs);
    timer.unref();
  }
}
