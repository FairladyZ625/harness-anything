import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentRuntimeEventV1, CanonicalEventStore, SessionIdentity } from "../../kernel/src/index.ts";
import {
  consumeKnownError,
  currentSubmittedExecutions,
  isSameExecution,
  isSamePerson,
  resolveTaskBoundRuntimeBinding,
  runtimeDefinitionSnapshotArtifact,
  runtimeSessionIdFromActor,
  type AuthorizationDecision,
} from "../../kernel/src/index.ts";
import { presetDocumentBody } from "../../preset/src/preset-resolver.ts";
import { presetRuntimeDefaults, presetUserRoot } from "../../preset/src/preset-system.ts";
import {
  agentRuntimeTargetForKind,
  agentRuntimeKindMismatchDetail,
  agentRuntimeKindMatches,
} from "./agent-runtime-contract.ts";
import { resolveAgentSkills } from "./agent-skills.ts";
import {
  openDispatchStream,
  readDispatchStream,
  reopenDispatchStream,
  removeDispatchStream,
  scrubProviderValue,
  type DispatchStreamWriter,
} from "./dispatch-stream.ts";
import { unknownFieldViolation, type JsonObject } from "./protocol/json-rpc-types.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { runtimePermissionMode } from "./runtime-permissions.ts";
import { scheduleMissionWithOutcomeProtocol } from "./schedule-runtime-outcome.ts";
import {
  isSealedRuntimeDaemonRoute,
  removeRuntimeCallbackRelay,
  runtimeCallbackRelaySpec,
} from "./runtime-callback-relay.ts";
import { cancelRuntime, closeRuntimes } from "./runtime-spawn-control.ts";
import { createActiveRuntime, attachActiveRuntime } from "./runtime-spawn-active.ts";
import { adoptRuntimes } from "./runtime-spawn-adoption.ts";
import {
  isRuntimeEvent,
  requiredRuntimeSpawnText,
  runtimeErrorMessage,
  runtimeSpawnError,
  runtimeTaskLeaseRequiredMessage,
} from "./runtime-spawn-errors.ts";
import {
  assembleAgentPrompt,
  assembleUnboundPrompt,
  assembleScheduledMission,
  assembleTaskMission,
  deriveTaskMission,
  dispatchMissionForPermission,
  resolveRuntimeInstanceId,
  runtimeMissionName,
  explicitPromptMission,
  validateMissionCommands,
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
import { isProviderFailureClassification } from "./runtime-fallback-contract.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import type { RuntimeEventOf, RuntimeEventType, RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { assertReviewReturnBudgetAvailable, selectReviewTarget } from "./review-dispatch-admission.ts";
import { continuationMission, initialFallbackAttempt, requiredRuntimeFast } from "./runtime-spawn-fallback.ts";
import { admitRuntimeResume, assertResumeAgent, resolveResumeCwd } from "./runtime-resume-admission.ts";
export const resultMediaType = "text/plain; charset=utf-8" as const,
  providerErrorLimit = 64 * 1024,
  resumeAdmissionTimeoutMs = 30_000,
  exitNotificationTimeoutMs = 30_000;

export function makeRuntimeSpawner(input: RuntimeSpawnerInput) {
  const processes = new Map<string, ActiveRuntime>(),
    exiting = new Set<string>(),
    launch = input.launch ?? launchNative,
    prepareWorkerGitEnvironment = async (instanceId: string): Promise<NodeJS.ProcessEnv | undefined> => {
      const credentialEnvironment = await input.prepareWorkerGitEnvironment?.(instanceId);
      return credentialEnvironment
        ? {
            ...credentialEnvironment,
            GIT_ASKPASS: path.join(input.rootDir, "tools", "git-hooks", "git-askpass"),
            HARNESS_TASK_BOUND: "1",
          }
        : undefined;
    };
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
    retainCoordinatorTaskLease = false,
    writableRoots: readonly string[] = [],
  ): Promise<JsonObject> => {
    const allowed = [
        "runtimeInstanceId",
        "dispatchId",
        "agentId",
        "targetAgentId",
        "squadId",
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
        "idempotencyKey",
        "providerSessionId",
        "dryRun",
      ],
      unknownField = unknownFieldViolation(payload, allowed);
    if (unknownField)
      throw runtimeSpawnError("invalid_runtime_spawn", `Runtime spawn payload contains an ${unknownField}`);
    const dryRun = payload.dryRun === true;
    const requestedDispatchId =
        payload.dispatchId === undefined ? undefined : requiredRuntimeSpawnText(payload.dispatchId, "dispatchId"),
      resumed = admitRuntimeResume(input.rootDir, requestedDispatchId);
    const explicitRuntimeInstanceId =
        payload.runtimeInstanceId === undefined
          ? resumed?.header.instanceId
          : requiredRuntimeSpawnText(payload.runtimeInstanceId, "runtimeInstanceId"),
      explicitMission = payload.prompt === undefined ? undefined : requiredRuntimeSpawnText(payload.prompt, "prompt"),
      missionName = payload.missionName === undefined ? undefined : runtimeMissionName(payload.missionName),
      agentId =
        payload.agentId === undefined ? resumed?.header.agentId : requiredRuntimeSpawnText(payload.agentId, "agentId"),
      targetAgentId =
        payload.targetAgentId === undefined
          ? undefined
          : requiredRuntimeSpawnText(payload.targetAgentId, "targetAgentId"),
      squadId = payload.squadId === undefined ? undefined : requiredRuntimeSpawnText(payload.squadId, "squadId"),
      role = payload.role === undefined ? undefined : requiredRuntimeSpawnText(payload.role, "role"),
      // Delegation provenance: which already-running runtime session invoked this spawn.
      parentRuntimeSessionId = runtimeSessionIdFromActor(binding.actor),
      model = payload.model === undefined ? resumed?.header.model : requiredRuntimeSpawnText(payload.model, "model"),
      effort = payload.effort === undefined ? undefined : requiredRuntimeSpawnText(payload.effort, "effort"),
      fast = payload.fast === undefined ? undefined : requiredRuntimeFast(payload.fast),
      permissionMode =
        payload.permissionMode === undefined
          ? (resumed?.header.permissionMode ?? undefined)
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
          ? (resumed?.header.taskId ?? null)
          : requiredRuntimeSpawnText(payload.taskId, "taskId"),
      requestedExecutionId =
        payload.executionId === undefined ? undefined : requiredRuntimeSpawnText(payload.executionId, "executionId"),
      providerSessionId =
        typeof payload.providerSessionId === "string"
          ? requiredRuntimeSpawnText(payload.providerSessionId, "providerSessionId")
          : resumed?.providerSessionId;
    assertResumeAgent(requestedDispatchId, resumed?.header.agentId, payload.agentId, agentId);
    if (missionName && !taskId)
      throw runtimeSpawnError("invalid_runtime_mission", "Use --mission <name> only with --task <task-id>.");
    if (missionName && explicitMission)
      throw runtimeSpawnError("invalid_runtime_mission", "Use --mission <name> or --prompt <text>, not both.");
    if (targetAgentId !== undefined && agentId === undefined)
      throw runtimeSpawnError("squad_leader_required", "Targeted squad dispatch requires --agent <leader-id>.");
    if (squadId !== undefined && agentId === undefined)
      throw runtimeSpawnError("squad_leader_required", "Squad attribution requires --agent <leader-id>.");
    const cwd = resolveResumeCwd(input.rootDir, payload.cwd, resumed?.header.cwd),
      store = input.remote ? null : requiredRuntimeStore(input),
      projection = input.remote ? null : requiredRuntimeProjection(input),
      remoteTask = taskId && input.remote ? await input.remote.taskContext(taskId, missionName) : null;
    const reviewerBinding = role === "reviewer";
    // A reviewer binds to a submitted cut through the review surface only; a role-reviewer spawn
    // without a task can never select that cut and must not fall back to a task-less runtime.
    if (reviewerBinding && taskId === null)
      throw runtimeSpawnError(
        "invalid_runtime_spawn",
        "Reviewer dispatch requires a reviewed task id; use ha task dispatch-review <task-id>.",
      );
    if (requestedExecutionId !== undefined && !reviewerBinding)
      throw runtimeSpawnError(
        "invalid_runtime_spawn",
        "executionId only applies to a reviewer dispatch; use ha task dispatch-review <task-id> --execution-id <id>.",
      );
    if (reviewerBinding && taskId !== null && input.remote && remoteTask?.executionId === undefined)
      throw runtimeSpawnError(
        "review_target_missing",
        `Remote task context for ${taskId} returned no submitted execution to review.`,
      );
    // Every local spawn (runtime.run, squad turns, fallback continuations) runs in the RepoCell write queue.
    const taskSnapshot =
        taskId && !input.remote ? requireCurrentTaskProjection(projection!, taskId, "runtime.run").snapshot : null,
      leaseAtAdmission = taskId && !input.remote ? projection!.currentLease(taskId) : null,
      reviewExecutions =
        taskSnapshot?.task?.status === "in_review" &&
        taskSnapshot.task.currentNode === "review" &&
        taskSnapshot.lease === null
          ? currentSubmittedExecutions(taskSnapshot)
          : [],
      reviewExecution = reviewExecutions.length === 1 ? reviewExecutions[0]! : null,
      // A reviewer dispatch binds to the submitted cut under review — never to the task's active
      // implementation execution or lease — so it cannot observe, open, or mutate an implementation
      // iteration. Selection happens here so every entry (task dispatch-review, completion facade)
      // enforces the same invariant.
      reviewTarget = reviewerBinding
        ? selectReviewTarget(taskId, requestedExecutionId, taskSnapshot, input.remote != null)
        : null,
      hash = createHash("sha256").update(`${input.repoId}\0${idempotencyKey}`).digest("hex"),
      newDispatchId = `dispatch_${hash.slice(0, 24)}`,
      runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
      dispatchOpId = `runtime-spawn-${hash.slice(0, 32)}`,
      trustedHandoffSource = handoffFromRuntimeSessionId ?? resumed?.header.runtimeSessionId ?? null;
    const authorizationDecision: AuthorizationDecision | null = binding.authorizationDecision ?? null;
    if (taskId && !input.remote && !reviewerBinding) {
      const callerRuntimeSessionId = runtimeSessionIdFromActor(binding.actor),
        runtimeBinding =
          callerRuntimeSessionId === null || leaseAtAdmission === null
            ? null
            : resolveTaskBoundRuntimeBinding(
                projection!.readRuntimeSession(callerRuntimeSessionId),
                taskId,
                leaseAtAdmission.executionId,
              );
      const leaseExecutorId = leaseAtAdmission?.actor.executor?.id ?? null,
        leaseHeldByRuntime = leaseExecutorId?.startsWith("runtime-session:") === true,
        dispatchLeaseExecutor = `runtime-session:${runtimeSessionId}`,
        trustedSourceExecutor = trustedHandoffSource ? `runtime-session:${trustedHandoffSource}` : null;
      const leaseQualifies =
        leaseAtAdmission === null || leaseAtAdmission.phase === "released" || leaseAtAdmission.phase === "orphaned"
          ? input.handoffTaskLease !== undefined
          : leaseAtAdmission.phase === "held" &&
            isSamePerson(leaseAtAdmission.actor, binding.actor) &&
            (isSameExecution(leaseAtAdmission.actor, binding.actor) ||
              runtimeBinding !== null ||
              leaseExecutorId === dispatchLeaseExecutor ||
              leaseExecutorId === trustedSourceExecutor ||
              (binding.actor.executor === null && !leaseHeldByRuntime));
      // A dry-run preview assembles the injected prompt without lease or
      // authorization admission — it must answer before either exists.
      if (!dryRun && (!authorizationDecision || authorizationDecision.outcome !== "allowed"))
        throw runtimeSpawnError(
          "authorization_missing",
          "Runtime dispatch requires the center AuthorizationPort decision.",
        );
      if (!dryRun && !leaseQualifies && reviewExecution === null)
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
        ? (remoteTask ??
          deriveTaskMission(input.rootDir, projection!, taskId, "runtime.run", missionName, causalContext))
        : null,
      mission =
        explicitMission === undefined
          ? (taskMission?.mission ?? requiredRuntimeSpawnText(undefined, "prompt"))
          : explicitPromptMission(taskId, causalContext, explicitMission);
    if (taskMission) validateMissionCommands(taskMission.plan, cwd, taskMission.planPath);
    if (taskMission?.missionBody && taskMission.missionPath)
      validateMissionCommands(taskMission.missionBody, cwd, taskMission.missionPath);
    if (explicitMission) validateMissionCommands(explicitMission, cwd, "explicit runtime mission");
    const remoteExisting = input.remote ? await input.remote.existing(dispatchOpId) : null,
      existing = input.remote ? null : store!.readEvent(dispatchOpId);
    if (!dryRun && remoteExisting)
      return {
        ...remoteExisting,
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
        authorizationDecision: authorizationDecision as unknown as JsonObject | null,
      };
    }
    // Reviewer fail-fast: a new review attempt is refused before any dispatch event or worker
    // process exists when the return budget is already spent, because the ledger can no longer
    // record a changes_requested verdict for the cut. An already-claimed attempt returned above
    // keeps its identity; an already-approved review completes unaffected. The judgment reads
    // the latest center snapshot, so every entry (submit-time review, complete facade,
    // dispatch-review, runtime.run, fallback continuation) enforces the same write-side rule.
    if (reviewerBinding && reviewTarget !== null && taskSnapshot?.task) {
      assertReviewReturnBudgetAvailable(projection!, taskId!, taskSnapshot.task);
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
      resolvedSkills = agent ? resolveAgentSkills({ rootDir: input.rootDir, skills: agent.skills }) : [],
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
      callbackRelay =
        globalThis.process?.platform !== "win32" &&
        daemonRoute &&
        isSealedRuntimeDaemonRoute(daemonRoute) &&
        runtimeInstance?.kindId === "codex" &&
        runtimeInstance.isolationState === "enforced" &&
        (effectivePermissionMode === "workspace-write" || effectivePermissionMode === "read-only")
          ? runtimeCallbackRelaySpec(input.rootDir, newDispatchId, daemonRoute)
          : undefined,
      missionDaemonRoute =
        callbackRelay && daemonRoute ? { userRoot: "", daemonId: "", endpoint: callbackRelay.path } : daemonRoute,
      selfContainedMission =
        taskMission && daemonRoute
          ? assembleTaskMission({
              mission,
              repoId: input.repoId,
              canonicalRoot: input.rootDir,
              workerRoot: cwd,
              taskId: taskId!,
              taskPackageRoot: taskMission.packageRoot,
              daemonRoute: missionDaemonRoute!,
              runtimeActor,
            })
          : trustedSchedule && daemonRoute
            ? assembleScheduledMission({
                mission,
                repoId: input.repoId,
                canonicalRoot: input.rootDir,
                workerRoot: cwd,
                scheduleId: trustedSchedule.scheduleId,
                claimFence: trustedSchedule.claimFence,
                daemonRoute: missionDaemonRoute!,
                runtimeActor,
              })
            : mission,
      readOnlyDispatch = effectivePermissionMode === "read-only",
      dispatchMission = dispatchMissionForPermission(selfContainedMission ?? mission, effectivePermissionMode),
      assembledPrompt = agent
        ? assembleAgentPrompt(agent, dispatchMission, preset, resolvedSkills)
        : taskMission
          ? assembleUnboundPrompt(dispatchMission)
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
        ...(writableRoots.length > 0 ? { writableRoots } : {}),
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
    if (agent && !agentRuntimeKindMatches(agent.runtimes, declaredKindId))
      throw runtimeSpawnError(
        "agent_runtime_type_mismatch",
        agentRuntimeKindMismatchDetail(agent.id, agent.runtimes, runtimeInstanceId, definition.kindId),
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
    // A squad coordinator explicitly retains one stable binding while sibling workers share the
    // same lease generation. Direct runtime/batch dispatches still transfer ownership even when
    // they select a squad member through --to.
    const taskLeaseHandoff =
        taskId && !input.remote && !reviewerBinding && reviewExecution === null && !retainCoordinatorTaskLease
          ? input.handoffTaskLease
          : undefined,
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
    // Enforced runtimes replace HOME and TMPDIR, so a task worker needs the daemon's sealed callback
    // route as well as its own executor identity.
    const workerLaunch =
      (taskId || trustedSchedule || reviewerBinding) && daemonRoute
        ? {
            ...prepared,
            env: {
              ...prepared.env,
              ...workerGitEnvironment,
              ...workerIdentityEnvironment,
              HARNESS_CANONICAL_ROOT: input.rootDir,
              PATH: [
                path.join(input.rootDir, "tools", "git-hooks"),
                prepared.env.PATH ?? globalThis.process?.env.PATH ?? "",
              ]
                .filter(Boolean)
                .join(path.delimiter),
              HARNESS_DAEMON_USER_ROOT: daemonRoute.userRoot,
              HARNESS_DAEMON_ID: daemonRoute.daemonId,
              HARNESS_DAEMON_ENDPOINT: callbackRelay?.path ?? daemonRoute.endpoint,
              HARNESS_DAEMON_RELAY: callbackRelay ? "1" : undefined,
              HARNESS_DAEMON_REPO_ID: input.repoId,
              HARNESS_ACTOR: runtimeActor,
              ...(taskId ? { HARNESS_TASK_BOUND: "1" } : {}),
              ...(trustedSchedule
                ? {
                    HARNESS_SCHEDULE_ID: trustedSchedule.scheduleId,
                    HARNESS_SCHEDULE_CLAIM_FENCE: trustedSchedule.claimFence,
                    HARNESS_SCHEDULE_MODE: trustedSchedule.mode,
                  }
                : {}),
            },
          }
        : prepared;
    const taskBinding = taskId
        ? {
            taskId,
            executionId:
              remoteTask?.executionId ??
              (reviewerBinding ? reviewTarget!.executionId : (lease?.executionId ?? reviewExecution!.executionId)),
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
        ...(requestedDispatchId ? { resumedFromDispatchId: requestedDispatchId } : {}),
        ...(onExitCommand ? { onExitCommand } : {}),
        ...(role ? { role } : {}),
        ...(agent ? { agentId: agent.id, agentName: agent.name } : {}),
        ...(squad ? { squadId: squad.squadId } : {}),
        ...(parentRuntimeSessionId ? { parentRuntimeSessionId } : {}),
        ...(delegatedBy
          ? {
              delegatedByAgentId: delegatedBy.id,
              delegatedByAgentName: delegatedBy.name,
            }
          : {}),
      }));
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
    const launchPreparedProcess = () =>
      launchRuntimeProcess(
        launch,
        workerLaunch,
        {
          rootDir: input.rootDir,
          dispatchId: newDispatchId,
          ...(callbackRelay ? { callbackRelay } : {}),
        },
        providerSessionId,
      );
    // Remote resumes must first win center admission, just like fresh provider launches.
    if (providerSessionId && !input.remote)
      try {
        openStream();
        ({ process, resumeObservation } = await launchPreparedProcess());
      } catch (error) {
        await cleanupFailedLaunch(error);
        throw error;
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
        {
          dispatchId: newDispatchId,
          runtimeSessionId,
          instanceId: definition.instanceId,
          installationId: definition.installationId,
          kindId: definition.kindId,
          idempotencyKey,
          definitionSnapshotRef,
          definitionSnapshot: definition,
        },
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
      parentRuntimeSessionId: parentRuntimeSessionId ?? null,
      binding: activeBinding,
      task: taskBinding,
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
    spawn: (payload: JsonObject, binding: RuntimeBinding) => spawnAttempt(payload, binding),
    spawnCoordinated: (payload: JsonObject, binding: RuntimeBinding) =>
      spawnAttempt(payload, binding, undefined, undefined, undefined, true),
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
          permissionMode: scheduled.mode === "detect" ? "read-only" : "workspace-write",
        },
        binding,
        undefined,
        scheduled,
        undefined,
        false,
        scheduled.writableRoots ?? [],
      ),
    adopt: () => adoptRuntimes(extracted),
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
  async function publishExit(active: ActiveRuntime, code: number | null): Promise<void> {
    return publishExitImpl(extracted, active, code);
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
    const fallback = active.fallbackAttempt;
    if (!isProviderFailureClassification(outcome.classification) || !fallback) {
      await input.onAttemptTerminal?.(terminal);
      return;
    }
    const nextAttemptIndex = fallback.attemptIndex + 1,
      exhausted = nextAttemptIndex >= fallback.candidates.length;
    if (exhausted) {
      const reason = `Provider fallback exhausted after ${String(nextAttemptIndex)} attempt(s): ${outcome.reason}`;
      active.stream.appendFallbackState({ state: "exhausted", reason }, input.now());
      try {
        await input.onAttemptTerminal?.({ ...terminal, outcome: "failed", reason });
      } catch (error) {
        const settlementReason = [
          "Provider fallback exhaustion could not settle terminal state: ",
          runtimeErrorMessage(error),
        ].join("");
        active.stream.appendFallbackState({ state: "exhausted", reason: settlementReason }, input.now());
        console.warn(`[runtime-fallback] ${settlementReason}`);
        throw error;
      }
      return;
    }
    const next = fallback.candidates[nextAttemptIndex]!,
      delayMs = Math.min(fallback.backoff.maxMs, fallback.backoff.baseMs * 2 ** fallback.attemptIndex),
      notBeforeAt = new Date(Date.parse(input.now()) + delayMs).toISOString();
    active.stream.appendFallbackState({ state: "scheduled", delayMs, notBeforeAt, nextProvider: next }, input.now());
    reconcileFallback(readDispatchStream(input.rootDir, active.dispatchId));
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
              input.authorizeRuntimeContinuation?.(
                continuationPayload,
                binding,
                `runtime-continuation:${header.dispatchId}:${nextAttemptIndex}`,
              ) ?? binding;
          const receipt = await spawnAttempt(
            continuationPayload,
            continuationBinding,
            nextFallback,
            header.schedule,
            header.runtimeSessionId,
            header.taskId !== null && binding.actor.executor?.id !== `runtime-session:${header.runtimeSessionId}`,
          );
          writer.appendFallbackState(
            {
              state: "dispatched",
              nextDispatchId: String(receipt.dispatchId),
              nextRuntimeSessionId: String(receipt.runtimeSessionId),
            },
            input.now(),
          );
        } catch (error) {
          consumeKnownError(error);
          const reason = `Provider fallback could not launch ${next.instance}: ${runtimeErrorMessage(error)}`;
          writer.appendFallbackState({ state: "exhausted", reason }, input.now());
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
