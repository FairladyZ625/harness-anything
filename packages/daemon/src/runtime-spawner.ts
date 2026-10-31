import type { SquadDispatchContext } from "@harness-anything/kernel";
import { DEFAULT_RUNTIME_STALL_TIMEOUT_MS } from "@harness-anything/kernel";
import type { RuntimeHandoffCheckpoint } from "./runtime-handoff-store.ts";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { type AgentRuntimeEventV1, type CanonicalEventStore } from "@harness-anything/kernel";
import {
  runtimeDefinitionSnapshotArtifact,
  runtimeSessionIdFromActor,
  submissionDigest,
  type AuthorizationDecision,
} from "@harness-anything/kernel";
import { agentRuntimeModelSpelling, agentRuntimeTargetForKind } from "./agent-runtime-contract.ts";
import { agentRuntimeAmbiguityWarning, selectedRuntimeInstance } from "./runtime-instance-selection.ts";
import { resolveDispatchAgent } from "./runtime-spawn-agent.ts";
import { assertAgentDispatchable } from "./agent-entities.ts";
import { sharedProviderDirectory } from "./agent-runtime-instance-storage.ts";
import {
  openDispatchStream,
  removeDispatchStream,
  scrubProviderValue,
  type DispatchStreamWriter,
} from "./dispatch-stream.ts";
import { type JsonObject } from "./protocol/json-rpc-types.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { resolveRuntimeDispatchResources } from "./runtime-spawn-allowlist.ts";
import { runtimePermissionMode } from "./runtime-permissions.ts";
import { dispatchCallbackRelay, removeRuntimeCallbackRelay } from "./runtime-callback-relay.ts";
import { cancelRuntime, closeRuntimes, enforceRuntimeSpendCap, steerRuntime } from "./runtime-spawn-control.ts";
import { createActiveRuntime, attachActiveRuntime } from "./runtime-spawn-active.ts";
import { adoptRuntimes, reclaimFailedLaunchTempDirectory } from "./runtime-spawn-adoption.ts";
import {
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
  requiredRuntimeProjection,
  requiredRuntimeStore,
} from "./runtime-spawn-process.ts";
import { isStructuredSuccessResult, parseProviderFrame } from "./runtime-spawn-provider-frames.ts";
import { publishRuntimeEvent as publishRuntimeEventImpl } from "./runtime-spawn-provider-stream.ts";
import * as runtimeSpawnerDelegates from "./runtime-spawner-delegates.ts";
import { runtimeBindingForDispatch } from "./runtime-spawn-types.ts";
import { configureWorkerGitIdentity } from "./runtime-worker-push.ts";
import type {
  ActiveRuntime,
  ResumeProcessObservation,
  RuntimeBinding,
  RuntimeSpawnerInput,
  RuntimeProcess,
  TrustedScheduleRuntime,
  TrustedScheduleSpawn,
} from "./runtime-spawn-types.ts";
import type { RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { runtimeDispatchRequestedPayload } from "./runtime-spawn-event.ts";
import { daemonCliBinDirectory, prepareBoundRuntimeLaunch } from "./runtime-spawn-context.ts";
import type { RuntimeEventOf, RuntimeEventType, RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { assertReviewerTarget, selectReadOnlyAttachTarget, selectReviewTarget } from "./review-dispatch-admission.ts";
import { assertContextBudget, ModelSlotQueue } from "./runtime/model-slot-queue.ts";
import { relayBudgetMicrosOf } from "./runtime/cloud-dispatch-relay.ts";
import { initialFallbackAttempt, reconcileFallback, requiredRuntimeFast } from "./runtime-spawn-fallback.ts";
import {
  resolveRuntimeResume,
  assertNativeResumeNotExported,
  assertRuntimeHandoffLaunch,
  assertResumeAgent,
  readOnlyAttachDispatch,
  prepareDispatchWorktree,
  projectedWorktreeBinding,
  resolveDispatchCwd,
  dispatchTaskPackageRoot,
} from "./runtime-resume-admission.ts";
import { installHandoffRollout } from "./runtime-handoff-native.ts";
import { taskWorktreeCheckoutNote, verifyHandoffWorktree, type TaskWorktreeCheckout } from "./task-worktree.ts";
import { assertTaskDispatchPrerequisites, taskDispatchLeaseQualifies } from "./task-dispatch-admission.ts";
export const resultMediaType = "text/plain; charset=utf-8" as const,
  providerErrorLimit = 64 * 1024,
  resumeAdmissionTimeoutMs = 30_000,
  exitNotificationTimeoutMs = 30_000;
// Captured at module level: spawnAttempt's local `process` names the launched RuntimeProcess.
const hostPlatform = process.platform;
export function makeRuntimeSpawner(input: RuntimeSpawnerInput) {
  const processes = new Map<string, ActiveRuntime>(),
    exiting = new Set<string>(),
    launch = input.launch ?? launchNative,
    prepareDaemonGitEnvironment = (instanceId: string, provider: "github" | "gitlab" = "github") =>
      input.prepareDaemonGitEnvironment?.(instanceId, provider).then((value) => value ?? undefined) ??
      Promise.resolve(undefined);
  const modelSlotQueue = input.modelSlotQueue ?? new ModelSlotQueue({ globalCapacity: 64, perOwnerCapacity: 64 });
  const ownsModelSlotQueue = input.modelSlotQueue === undefined;
  let fallbackClosed = false;
  const preflightRuntimeSelection = async (payload: JsonObject): Promise<void> => {
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
      agent = agentId === undefined ? null : (input.resolveAgent?.(agentId) ?? null),
      requested = runtimeInstanceId ?? agent?.instance;
    if (requested === undefined) return;
    const projection = input.remote ? null : requiredRuntimeProjection(input),
      [sessions, instances, allowedInstanceIds, health] = await resolveRuntimeDispatchResources(
        input,
        input.remote,
        projection,
        processes,
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
  };
  const extracted: RuntimeSpawnerContext = {
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
    processes,
    providerErrorLimit,
    publishRuntimeEvent,
    exiting,
    runtimeResultText: (active, code, outcome) =>
      runtimeSpawnerDelegates.runtimeResultText(extracted, active, code, outcome),
    resultMediaType,
    launchExitNotification,
    publishExit: (active, code, resumePublishedExit) =>
      runtimeSpawnerDelegates.publishExit(extracted, active, code, resumePublishedExit),
    enforceSpendCap: (active) => enforceRuntimeSpendCap(extracted, active),
    controlReceipt: (opId, runtimeSessionId, detail) =>
      runtimeSpawnerDelegates.controlReceipt(extracted, opId, runtimeSessionId, detail),
    captureErrorOutput: (active, chunk) => runtimeSpawnerDelegates.captureErrorOutput(extracted, active, chunk),
    prepareDaemonGitEnvironment,
    settleFallback: (active, outcome, terminal) =>
      runtimeSpawnerDelegates.settleFallback(extracted, active, outcome, terminal),
    reconcileFallback: (stream) =>
      reconcileFallback({
        input,
        publishRuntimeEvent: extracted.publishRuntimeEvent,
        closed: () => fallbackClosed,
        launch: (payload, binding, fallback, schedule, handoffFromRuntimeSessionId, publicationOwner, onDispatched) =>
          spawnAttempt(
            payload,
            binding,
            fallback,
            schedule,
            handoffFromRuntimeSessionId,
            publicationOwner,
            null,
            undefined,
            undefined,
            onDispatched,
          ),
        stream,
      }),
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
    handoffRollout?: Uint8Array,
    onDispatched?: (dispatchId: string, runtimeSessionId: string) => void,
    onPrepared?: (dispatchId: string, runtimeSessionId: string) => void,
  ): Promise<JsonObject> => {
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
      dispatchKey = requiredRuntimeSpawnText(payload.dispatchKey, "dispatchKey"),
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
        reviewerBinding && taskId !== null
          ? selectReviewTarget(taskId, requestedExecutionId, taskSnapshot, input.remote != null)
          : null,
      hash = createHash("sha256").update(`${input.repoId}\0${dispatchKey}`).digest("hex"),
      newDispatchId = `dispatch_${hash.slice(0, 24)}`,
      runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
      dispatchOpId = randomUUID(),
      installationOpId = randomUUID(),
      trustedHandoffSource = handoffFromRuntimeSessionId ?? resumed?.header.runtimeSessionId ?? null;
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
            input.resolveAgent(agentId)?.permissionMode === "read-only"
          : false,
      attachTarget = readOnlyAttach ? selectReadOnlyAttachTarget(taskId!, taskSnapshot!) : null;
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
      // A read-only attach is the exception: it writes nothing, so it may observe the frozen cut.
      if (!dryRun && !readOnlyAttach && frozenTask) throw runtimeTaskExecutionFrozenError(taskId, frozenStatus);
      if (!dryRun && !readOnlyAttach && !leaseQualifies)
        throw runtimeSpawnError(
          "runtime_task_lease_required",
          runtimeTaskLeaseRequiredMessage(taskId, leaseAtAdmission),
        );
    }
    const taskPackageRoot = dispatchTaskPackageRoot(input, taskId, remoteTask),
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
        taskPackageRoot,
      );
    const runtimeActor = `agent:runtime-session:${runtimeSessionId}`,
      [localRuntimeSessions, runtimeInstances, allowedInstanceIds, providerHealth] =
        await resolveRuntimeDispatchResources(input, input.remote, projection!, processes),
      { squad, delegatedBy, agent, resolvedSkills, preset } = resolveDispatchAgent(
        input,
        binding,
        cwd,
        agentId,
        squadId,
        targetAgentId,
      );
    if (agent) assertAgentDispatchable(agent);
    // A dispatch of an agent that DECLARES read-only (the bundled ask-agent surface) is
    // daemon-bound like a task dispatch: it gets the daemon route and, in prepareBoundRuntimeLaunch,
    // an allowlist-only execution credential — without one it would reach the daemon unauthenticated
    // through its relay. Instance-configured modes and per-dispatch overrides change only the
    // sandbox; they do not make a dispatch daemon-bound.
    const unboundReadOnlyAgent =
        !taskId && !trustedSchedule && !reviewerBinding && agent !== null && agent.permissionMode === "read-only",
      daemonRoute =
        taskId || trustedSchedule || reviewerBinding || unboundReadOnlyAgent ? input.runtimeDaemonRoute : undefined;
    if ((taskId || trustedSchedule || reviewerBinding || unboundReadOnlyAgent) && !daemonRoute)
      throw runtimeSpawnError(
        "runtime_preconditions_unavailable",
        "Task-bound, scheduled, and read-only agent runtime spawn require a sealed daemon route before dispatch.",
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
    // A named instance and its model are validated before mission loading reads and assembles the
    // submitted task cut; model errors must not wait behind review-context preparation.
    const { taskMission, mission } = await resolveRuntimeMission({
        rootDir: input.rootDir,
        cwd,
        taskId,
        projection,
        remoteTask,
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
    const selectRuntime = () =>
      prepareRuntimeInstance(
        {
          requested: requestedRuntimeInstanceId,
          providerSessionId: providerSessionId ?? undefined,
          agent,
          model,
          instances: runtimeInstances,
          allowedInstanceIds,
          sessions: localRuntimeSessions,
          health: providerHealth,
          now: input.now(),
        },
        async (runtimeInstanceId) => {
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
                  )
                : initialFallback,
            fallbackAttemptForDispatch = fallbackAttempt,
            fallbackCandidate =
              fallbackAttemptForDispatch?.candidates[
                fallbackAttemptForDispatch.candidateIndex ?? fallbackAttemptForDispatch.attemptIndex
              ],
            runtimeInstance = runtimeInstances.find((instance) => instance.instanceId === runtimeInstanceId),
            // The instance store validates model membership verbatim, so a declaration that
            // differs from the catalog only by letter case must launch the catalog spelling.
            requestedSelectedModel =
              fallbackCandidate?.model ??
              model ??
              (agent && runtimeInstance
                ? agentRuntimeTargetForKind(agent.runtimes, runtimeInstance.kindId)?.model
                : undefined),
            selectedModel =
              requestedSelectedModel === undefined || runtimeInstance === undefined
                ? requestedSelectedModel
                : (agentRuntimeModelSpelling(runtimeInstance.models, requestedSelectedModel) ?? requestedSelectedModel),
            selectedEffort =
              effort ??
              (agent && runtimeInstance
                ? agentRuntimeTargetForKind(agent.runtimes, runtimeInstance.kindId)?.effort
                : undefined),
            configuredPermissionMode = runtimeInstance?.permissionMode ?? undefined,
            requestedPermissionMode = permissionMode ?? agent?.permissionMode ?? configuredPermissionMode,
            // An artifact task owns only its package. A provider that cannot enforce this mode
            // must reject the launch; an agent or resumed bypass declaration cannot widen it.
            declaredPermissionMode =
              taskPackageRoot && (requestedPermissionMode === undefined || requestedPermissionMode === "bypass")
                ? "workspace-write"
                : (permissionMode ?? agent?.permissionMode),
            effectivePermissionMode = declaredPermissionMode ?? configuredPermissionMode,
            callbackRelay = dispatchCallbackRelay(newDispatchId, daemonRoute, runtimeInstance, effectivePermissionMode),
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
            // The self-iteration step rides every task-bound dispatch whose declaration mounts the
            // `self-iteration` skill — the skill mount is the only opt-in (`dec_43F5EA40143C5BD729EF90D030`
            // CH1), and both audiences opt in the same way. What differs is where the proposal lands:
            // a delivery turn owns its task package, while a reviewer may write nothing but its review
            // report (`runtime-execution-scope.ts:101,251-261`), so its proposal is a section of that
            // report. Read-only attaches cannot write either surface, so they stay excluded.
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
            ),
            // A worktree checks out no private ledger, so every `harness/…` reference the agent
            // declaration or the mission carries is answered with the path this worker can open;
            // an implementation dispatch also owes the isolated-test entry when nothing names it.
            privateReads = privateLedgerReadSection(
              resolvePrivateLedgerReads({
                rootDir: input.rootDir,
                cwd,
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
                )
              : taskMission || role === "reviewer"
                ? assembleUnboundPrompt(dispatchMission, role === "reviewer" ? role : undefined, privateReads)
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
                prompt,
                mission,
              }
            : null;
          let cloudRelay: Awaited<ReturnType<NonNullable<RuntimeSpawnerInput["prepareCloudRelay"]>>> | null = null;
          let prepared: Awaited<ReturnType<RuntimeSpawnerInput["prepareLaunch"]>> | null = null;
          if (!dryRun) {
            const budgetMicros = selectedModel ? relayBudgetMicrosOf(selectedModel, dispatchUsageLimit) : null;
            try {
              cloudRelay =
                input.prepareCloudRelay && budgetMicros !== null && selectedModel
                  ? await input.prepareCloudRelay({
                      instanceId: runtimeInstanceId,
                      attemptId: runtimeSessionId,
                      model: selectedModel,
                      budgetMicros,
                    })
                  : null;
              prepared = await input.prepareLaunch(runtimeInstanceId, {
                cwd,
                prompt,
                ...(selectedModel ? { model: selectedModel } : {}),
                ...(selectedEffort ? { effort: selectedEffort } : {}),
                ...(fast === undefined ? {} : { fast }),
                ...(declaredPermissionMode ? { permissionMode: declaredPermissionMode } : {}),
                ...(callbackRelay ? { callbackRelayPath: callbackRelay.path } : {}),
                ...(providerSessionId ? { providerSessionId } : {}),
                ...(cloudRelay ? { cloudRelay: { baseUrl: cloudRelay.baseUrl, token: cloudRelay.token } } : {}),
                runtimeSessionId,
                handshakeTimeoutMs: input.readSettings?.().runtime.providerHandshakeTimeoutMs,
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
      releaseModelSlot();
      throw error;
    }
    const runtimeInstanceId = selection.instanceId,
      { runtimeInstance, effectivePermissionMode, callbackRelay, readOnlyDispatch, prompt, preview, cloudRelay } =
        selection.launch;
    if (preview) return preview;
    const runtimeSelection = selectedRuntimeInstance({
        agent,
        ...(model === undefined ? {} : { model }),
        instances: runtimeInstances,
        selected: runtimeInstanceId,
        ...(explicitRuntimeInstanceId === undefined ? {} : { explicitlyRequested: true }),
        ...(providerSessionId === null || providerSessionId === undefined ? {} : { resumedSession: true }),
      }),
      prepared = selection.launch.prepared!,
      fallbackAttempt = selection.launch.fallbackAttempt,
      definition = prepared.definition,
      installation = prepared.installation,
      declaredKindId = runtimeKindForId(definition.kindId).kindId,
      launchedPermissionMode = runtimePermissionMode(effectivePermissionMode, declaredKindId);
    const definitionArtifact = runtimeDefinitionSnapshotArtifact(definition),
      definitionSnapshotRef = definitionArtifact.ref,
      runtimeKind = runtimeKindForId(definition.kindId),
      protocolFamily = runtimeKind.protocolFamily;
    let activeBinding: RuntimeBinding,
      taskLeaseHandoff: RuntimeSpawnerInput["handoffTaskLease"],
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
      if (taskId || trustedSchedule || reviewerBinding)
        await configureWorkerGitIdentity(cwd, binding.actor.principal.personId);
      if (handoff) await verifyHandoffWorktree(cwd, handoff.commit);
      // Every implementation runtime, including squad leaders, takes the actual lease. A read-only
      // attach takes none: it never asks for the handoff, so the frozen round's lease state stays untouched.
      taskLeaseHandoff =
        taskId && !input.remote && !reviewerBinding && !readOnlyAttach ? input.handoffTaskLease : undefined;
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
    let process: RuntimeProcess | undefined;
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
        ...(resolvedProviderDirectory ? { resolvedProviderDirectory } : {}),
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
    const cleanupCallbackRelay = (): void => {
      if (callbackRelay) removeRuntimeCallbackRelay(newDispatchId);
    };
    const cleanupFailedLaunch = async (error: unknown): Promise<void> => {
      process?.terminate();
      process?.release?.();
      releaseModelSlot();
      await cloudRelay?.close();
      cleanupCallbackRelay();
      if (stream) removeDispatchStream(input.rootDir, newDispatchId);
      reclaimFailedLaunchTempDirectory(input, runtimeInstanceId, runtimeSessionId);
      if (!taskLeaseHandoff || !taskBinding) return;
      await input.onAttemptTerminal?.({
        runtimeSessionId,
        dispatchId: newDispatchId,
        task: taskBinding,
        schedule: trustedSchedule ?? null,
        outcome: "failed",
        reason: `Runtime dispatch failed before provider registration: ${runtimeErrorMessage(error)}`,
        endedAt: input.now(),
        binding: activeBinding,
      });
    };
    try {
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
    // The handoff rollout is installed only after the target launch is prepared and admitted —
    // into the directory that launch actually resolved — and before any process or event, so a
    // resumed provider always reads the state selected for it and no earlier mutable-config
    // lookup can guess a different home.
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
    const launchPreparedProcess = async () => {
      const boundLaunch = await prepareBoundRuntimeLaunch({
        input,
        prepared,
        daemonRoute,
        callbackRelay,
        cliBinDir: daemonCliBinDirectory(),
        runtimeActor,
        taskId,
        trustedSchedule,
        reviewerBinding: Boolean(reviewerBinding),
        // A read-only attach mints no execution credential: it executes nothing, and a principal
        // labeled implementation or reviewer would misstate the session's authority either way.
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
                role: reviewerBinding ? "reviewer" : "implementation",
              },
            }
          : {}),
        // An unbound read-only agent dispatch (the ask-agent surface) gets the daemon route and
        // an allowlist-only credential instead of reaching the daemon unauthenticated through its
        // relay. Edge repos keep today's behavior; their credential path requires a task lease.
        ...(unboundReadOnlyAgent && !input.remote
          ? {
              execution: {
                repoId: input.repoId,
                personId: activeBinding.actor.principal.personId,
                source: activeBinding.source,
                runtimeSessionId,
                dispatchId: newDispatchId,
                taskId: null,
                executionId: null,
                role: "read-only" as const,
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
    if (onPrepared) {
      try {
        openStream();
        onPrepared(newDispatchId, runtimeSessionId);
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
        installationOpId,
        binding,
      );
      // The predecessor's fallback link must land before this dispatch becomes readable: the
      // event below projects the successor row, and no read may see that row while the
      // predecessor stream still says scheduled. A publish that fails after the link settles
      // exhausted in the continuation's catch instead of dangling on an unpublished dispatch.
      onDispatched?.(newDispatchId, runtimeSessionId);
      requested = await publishRuntimeEvent(
        "runtime_dispatch_requested",
        runtimeDispatchRequestedPayload(
          {
            dispatchId: newDispatchId,
            runtimeSessionId,
            instanceId: definition.instanceId,
            installationId: definition.installationId,
            kindId: definition.kindId,
            dispatchKey,
            definitionSnapshotRef,
            definitionSnapshot: definition,
            startedAt: streamStartedAt,
            ...(payload.squadRun ? { squadRun: payload.squadRun as unknown as SquadDispatchContext } : {}),
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
    if (requested.receipt?.reused === true) {
      releaseModelSlot();
      await cloudRelay?.close();
      cleanupCallbackRelay();
      // The id is deterministic from dispatchKey and may already be the winning stream after a
      // restart race. Removing it here can delete the winner's Squad state journal, leaving a
      // resumed coordinator unable to append its next revision.
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
        randomUUID(),
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
          randomUUID(),
          binding,
        );
        throw error;
      }
    const runtimeProcess = process;
    const releasedRuntimeProcess: RuntimeProcess = {
      ...runtimeProcess,
      release: () => {
        runtimeProcess.release?.();
        releaseModelSlot();
        void cloudRelay?.close();
      },
    };
    const active = createActiveRuntime({
      process: releasedRuntimeProcess,
      dispatchId: newDispatchId,
      runtimeSessionId,
      dispatchOpId,
      instanceId: definition.instanceId,
      kindId: declaredKindId,
      resolvedProviderDirectory: resolvedProviderDirectory ?? null,
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
      tokenLimit,
      stallTimeoutMs,
      lastProgressAtMs: Date.parse(streamStartedAt),
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
        { runtimeSessionId, liveness: "live", processGroupPid: runtimeProcess.pid },
        randomUUID(),
        binding,
      );
    }, activeBinding);
    // Attachment can refuse: a workspace the liveness watcher cannot open is a real fault, not a
    // reason to run unwatched. The process is already launched, so the failed-launch path retires
    // it — terminate, release, and drop the stream — instead of leaving a live worker owned by a
    // dispatch this call is about to report as failed.
    try {
      attachActiveRuntime(extracted, active, resumeObservation);
    } catch (error) {
      await cleanupFailedLaunch(error);
      throw error;
    }
    if (!requested.event || (!requested.receipt && !requested.publication))
      throw runtimeSpawnError("runtime_event_missing", "A dispatch start must have an accepted event.");
    // The receipt states which instance was chosen and which rule decided it; without this the
    // operator sees only an id and has to infer why a same-kind sibling was skipped.
    const selectionFields = {
        runtimeSelection: {
          instanceId: runtimeSelection.instanceId,
          basis: runtimeSelection.basis,
          reason: runtimeSelection.reason,
          model: definition.model,
        },
      },
      // `ha agent validate` / `ha agent install` warn before dispatch; the dispatch that actually
      // had to pick is the last moment the author can still be told the choice was unstated, so the
      // same warning rides this receipt and names the instance it took.
      ambiguity =
        agent === null
          ? null
          : agentRuntimeAmbiguityWarning({
              agent,
              runtimeInstances,
              selected: runtimeSelection.instanceId,
            }),
      // A launch without the operator's GitHub login still runs; this is the one place the operator
      // learns the worker cannot publish before the credential error would arrive at `ha task push`.
      notices = [ambiguity?.message, prepared.githubCredentialNotice].filter(
        (notice): notice is string => typeof notice === "string",
      ),
      // Merge, never replace: the receipt may already carry operator notices (for example the
      // hosting-credential warning) that this dispatch must not drop.
      existingWarnings = Array.isArray(requested.receipt?.warnings)
        ? (requested.receipt.warnings as readonly unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      warningFields: { warnings?: readonly string[] } =
        notices.length === 0 ? {} : { warnings: [...existingWarnings, ...notices] };
    return requested.receipt
      ? {
          ...requested.receipt,
          runtimeSessionId,
          dispatchId: newDispatchId,
          ...selectionFields,
          ...warningFields,
          ...(readOnlyDispatch ? { ledgerAccess: "unavailable", reportDelivery: "stdout" } : {}),
          authorizationDecision: authorizationDecision as unknown as JsonObject | null,
        }
      : {
          ...applied(requested.event, requested.publication!, runtimeSessionId, newDispatchId),
          ...selectionFields,
          ...warningFields,
          ...(readOnlyDispatch ? { ledgerAccess: "unavailable", reportDelivery: "stdout" } : {}),
          authorizationDecision: authorizationDecision as unknown as JsonObject | null,
        };
  };
  return {
    /** Checks a task dispatch's worktree out and prepares it; runs before the dispatch is queued for writing. */
    prepareWorktree: async (payload: JsonObject) => {
      // Explicit-instance and declared-Agent model failures must surface before checkout/setup
      // work, which can run repository-configured install commands.
      await preflightRuntimeSelection(payload);
      return prepareDispatchWorktree(
        input,
        payload,
        readOnlyAttachDispatch(input, payload) ? () => null : projectedWorktreeBinding(input),
      );
    },
    spawnHandoff: (
      checkpoint: RuntimeHandoffCheckpoint,
      payload: JsonObject,
      binding: RuntimeBinding,
      worktree: TaskWorktreeCheckout | null = null,
      rollout?: Uint8Array,
    ) => spawnAttempt(payload, binding, undefined, undefined, undefined, "runtime", worktree, checkpoint, rollout),
    spawn: (payload: JsonObject, binding: RuntimeBinding, worktree: TaskWorktreeCheckout | null = null) =>
      spawnAttempt(payload, binding, undefined, undefined, undefined, "runtime", worktree),
    spawnCoordinated: (
      payload: JsonObject,
      binding: RuntimeBinding,
      onPrepared?: (dispatchId: string, runtimeSessionId: string) => void,
    ) =>
      spawnAttempt(
        payload,
        binding,
        undefined,
        undefined,
        undefined,
        payload.targetAgentId === undefined ? "runtime" : "commander",
        null,
        undefined,
        undefined,
        undefined,
        onPrepared,
      ),
    spawnScheduled: (scheduled: TrustedScheduleSpawn, binding: RuntimeBinding) =>
      spawnAttempt(
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
          // Narrower modes refuse every shell call headless; detect states its no-write boundary in the mission.
          permissionMode: "bypass",
        },
        binding,
        undefined,
        scheduled,
        undefined,
      ),
    /** The same trusted-schedule channel for a caller-assembled payload: a scheduled Squad run's
     * leader turns carry the squad decision protocol, so their spawn comes from the coordinator. */
    spawnScheduledCoordinated: (
      payload: JsonObject,
      scheduled: TrustedScheduleRuntime,
      binding: RuntimeBinding,
      onPrepared?: (dispatchId: string, runtimeSessionId: string) => void,
    ) =>
      spawnAttempt(
        payload,
        binding,
        undefined,
        scheduled,
        undefined,
        "runtime",
        null,
        undefined,
        undefined,
        undefined,
        onPrepared,
      ),
    // Startup adoption only: cancel's mid-operation adoption call passes no sweep flag,
    // because a just-minted temp directory whose dispatch event has not committed yet must
    // not be reclaimed out from under an in-flight launch.
    adopt: (onProgress?: (completed: number) => void) =>
      adoptRuntimes(extracted, onProgress, { sweepTempDirectories: true }),
    cancel: (payload: JsonObject, binding: RuntimeBinding) => cancelRuntime(extracted, payload, binding),
    steer: (payload: JsonObject, binding: RuntimeBinding) => steerRuntime(extracted, payload, binding),
    close: () => {
      fallbackClosed = true;
      if (ownsModelSlotQueue) modelSlotQueue.close();
      closeRuntimes(extracted);
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
  const applied = (
    event: AgentRuntimeEventV1,
    publication: ReturnType<CanonicalEventStore["publication"]>,
    runtimeSessionId: string,
    dispatchId: string,
  ) => runtimeSpawnerDelegates.applied(extracted, event, publication, runtimeSessionId, dispatchId);
}
