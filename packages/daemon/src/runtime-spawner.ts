import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentRuntimeEventV1,
  CanonicalEventStore,
  SessionIdentity,
  SettingsV1,
  TaskProjection,
} from "../../kernel/src/index.ts";
import {
  consumeKnownError,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  type AuthorizationDecision,
} from "../../kernel/src/index.ts";
import { createRuntime } from "../../preset/src/preset-resolver.ts";
import { presetRuntimeDefaults, presetUserRoot } from "../../preset/src/preset-system.ts";
import type { SquadDispatchSelection } from "./agent-entities.ts";
import { runtimeTypeMatchesKind } from "./agent-runtime-contract.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import type { AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
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
import { cancelRuntime, closeRuntimes } from "./runtime-spawn-control.ts";
import { createActiveRuntime, attachActiveRuntime } from "./runtime-spawn-active.ts";
import { adoptRuntimes } from "./runtime-spawn-adoption.ts";
import {
  isRuntimeEvent,
  requiredRuntimeSpawnText,
  runtimeErrorCode,
  runtimeErrorMessage,
  runtimeSpawnError,
  runtimeTaskLeaseRequiredMessage,
} from "./runtime-spawn-errors.ts";
import {
  assembleAgentPrompt,
  assembleScheduledMission,
  assembleTaskMission,
  deriveTaskMission,
  resolveRuntimeCwd,
  resolveRuntimeInstanceId,
  runtimeMissionName,
  validateMissionCommands,
} from "./runtime-spawn-mission.ts";
import {
  launchExitNotification,
  launchNative,
  observeResumeProcess,
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
import type {
  ActiveRuntime,
  RemoteRuntimePersistence,
  ResumeProcessObservation,
  RuntimeAgent,
  RuntimeBinding,
  RuntimeDaemonRoute,
  RuntimeAttemptTerminal,
  RuntimeLauncher,
  RuntimeProcess,
  TrustedScheduleRuntime,
  TrustedScheduleSpawn,
} from "./runtime-spawn-types.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import { authorizeAction } from "./authorization.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import type { RuntimeEventOf, RuntimeEventType, RuntimeSpawnerContext } from "./runtime-spawn-context.ts";

export const resultMediaType = "text/plain; charset=utf-8" as const,
  providerErrorLimit = 64 * 1024,
  resumeAdmissionTimeoutMs = 30_000,
  exitNotificationTimeoutMs = 30_000;

export interface RuntimeSpawnerInput {
  readonly repoId: string;
  readonly rootDir: string;
  readonly daemonGeneration: number;
  readonly runtimeDaemonRoute?: RuntimeDaemonRoute;
  readonly store?: () => CanonicalEventStore;
  readonly projection?: () => TaskProjection;
  readonly readSettings?: () => SettingsV1;
  readonly remote?: RemoteRuntimePersistence;
  readonly stream: Pick<AgentRuntimeStreamHub, "publish">;
  readonly now: () => string;
  readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  readonly prepareLaunch: (
    instanceId: string,
    request: {
      readonly cwd: string;
      readonly prompt: string;
      readonly model?: string;
      readonly effort?: string;
      readonly providerSessionId?: string;
      readonly permissionMode?: string;
    },
  ) => Promise<PreparedRuntimeLaunch>;
  readonly prepareWorkerGitEnvironment?: (instanceId: string) => Promise<NodeJS.ProcessEnv | null>;
  readonly resolveAgent?: (agentId: string) => RuntimeAgent;
  readonly resolveSquadDispatch?: (
    squadId: string | undefined,
    leaderId: string,
    workerId?: string,
  ) => SquadDispatchSelection;
  readonly launch?: RuntimeLauncher;
  readonly schedule: (work: () => void | Promise<void>) => void;
  readonly onRuntimeOutcome?: (
    event: Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>,
    schedule: TrustedScheduleRuntime | null,
  ) => void;
  readonly onAttemptTerminal?: (terminal: RuntimeAttemptTerminal) => void | Promise<void>;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
}

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
  ): Promise<JsonObject> => {
    const allowed = [
        "runtimeInstanceId",
        "dispatchId",
        "agentId",
        "targetAgentId",
        "squadId",
        "model",
        "effort",
        "permissionMode",
        "cwd",
        "prompt",
        "promptSource",
        "missionName",
        "onExitCommand",
        "taskId",
        "idempotencyKey",
        "providerSessionId",
      ],
      unknownField = unknownFieldViolation(payload, allowed);
    if (unknownField)
      throw runtimeSpawnError("invalid_runtime_spawn", `Runtime spawn payload contains an ${unknownField}`);
    const requestedDispatchId =
        payload.dispatchId === undefined ? undefined : requiredRuntimeSpawnText(payload.dispatchId, "dispatchId"),
      resumed = requestedDispatchId ? readDispatchStream(input.rootDir, requestedDispatchId) : null;
    if (requestedDispatchId && !resumed?.providerSessionId)
      throw runtimeSpawnError(
        "runtime_dispatch_not_resumable",
        `Dispatch ${requestedDispatchId} has no provider session to resume.`,
      );
    const explicitRuntimeInstanceId =
        payload.runtimeInstanceId === undefined
          ? resumed?.header.instanceId
          : requiredRuntimeSpawnText(payload.runtimeInstanceId, "runtimeInstanceId"),
      explicitMission = payload.prompt === undefined ? undefined : requiredRuntimeSpawnText(payload.prompt, "prompt"),
      missionName = payload.missionName === undefined ? undefined : runtimeMissionName(payload.missionName),
      agentId = payload.agentId === undefined ? undefined : requiredRuntimeSpawnText(payload.agentId, "agentId"),
      targetAgentId =
        payload.targetAgentId === undefined
          ? undefined
          : requiredRuntimeSpawnText(payload.targetAgentId, "targetAgentId"),
      squadId = payload.squadId === undefined ? undefined : requiredRuntimeSpawnText(payload.squadId, "squadId"),
      // Delegation provenance: which already-running runtime session invoked this spawn.
      parentRuntimeSessionId = runtimeSessionIdFromActor(binding.actor),
      model = payload.model === undefined ? undefined : requiredRuntimeSpawnText(payload.model, "model"),
      effort = payload.effort === undefined ? undefined : requiredRuntimeSpawnText(payload.effort, "effort"),
      permissionMode =
        payload.permissionMode === undefined
          ? undefined
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
      providerSessionId =
        typeof payload.providerSessionId === "string"
          ? requiredRuntimeSpawnText(payload.providerSessionId, "providerSessionId")
          : resumed?.providerSessionId;
    if (missionName && !taskId)
      throw runtimeSpawnError("invalid_runtime_mission", "Use --mission <name> only with --task <task-id>.");
    if (missionName && explicitMission)
      throw runtimeSpawnError("invalid_runtime_mission", "Use --mission <name> or --prompt <text>, not both.");
    if (targetAgentId !== undefined && agentId === undefined)
      throw runtimeSpawnError("squad_leader_required", "Targeted squad dispatch requires --agent <leader-id>.");
    if (squadId !== undefined && agentId === undefined)
      throw runtimeSpawnError("squad_leader_required", "Squad attribution requires --agent <leader-id>.");
    const cwd = resolveRuntimeCwd(input.rootDir, payload.cwd),
      store = input.remote ? null : requiredRuntimeStore(input),
      projection = input.remote ? null : requiredRuntimeProjection(input),
      remoteTask = taskId && input.remote ? await input.remote.taskContext(taskId, missionName) : null,
      lease = taskId && !input.remote ? projection!.currentLease(taskId) : null,
      hash = createHash("sha256").update(`${input.repoId}\0${idempotencyKey}`).digest("hex"),
      newDispatchId = `dispatch_${hash.slice(0, 24)}`,
      runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
      dispatchOpId = `runtime-spawn-${hash.slice(0, 32)}`;
    let authorizationDecision: AuthorizationDecision | null = null;
    if (taskId && !input.remote) {
      const callerRuntimeSessionId = runtimeSessionIdFromActor(binding.actor),
        runtimeBinding =
          callerRuntimeSessionId === null || lease === null
            ? null
            : resolveTaskBoundRuntimeBinding(
                projection!.readRuntimeSession(callerRuntimeSessionId),
                taskId,
                lease.executionId,
              );
      authorizationDecision = authorizeAction("runtime.dispatch", `task/${taskId}`, binding.actor, dispatchOpId, {
        target: { lease, runtimeBinding },
        evaluatedAtCut: `canonical:${store!.readHead()?.revision ?? 0}`,
      });
    }
    if (authorizationDecision?.outcome === "denied")
      throw runtimeSpawnError("runtime_task_lease_required", runtimeTaskLeaseRequiredMessage(taskId!, lease));
    const daemonRoute = taskId || trustedSchedule ? input.runtimeDaemonRoute : undefined;
    if ((taskId || trustedSchedule) && !daemonRoute)
      throw runtimeSpawnError(
        "runtime_preconditions_unavailable",
        "Task-bound and scheduled runtime spawn require a sealed daemon route before dispatch.",
      );
    const taskMission = taskId
        ? (remoteTask ?? deriveTaskMission(input.rootDir, projection!, taskId, "runtime.run", missionName))
        : null,
      mission = explicitMission ?? taskMission?.mission ?? requiredRuntimeSpawnText(undefined, "prompt");
    if (taskMission) validateMissionCommands(taskMission.plan, cwd, taskMission.planPath);
    if (taskMission?.missionBody && taskMission.missionPath)
      validateMissionCommands(taskMission.missionBody, cwd, taskMission.missionPath);
    if (explicitMission) validateMissionCommands(explicitMission, cwd, "explicit runtime mission");
    const remoteExisting = input.remote ? await input.remote.existing(dispatchOpId) : null,
      existing = input.remote ? null : store!.readEvent(dispatchOpId);
    if (remoteExisting)
      return {
        ...remoteExisting,
        runtimeSessionId,
        dispatchId: newDispatchId,
        authorizationDecision: authorizationDecision as unknown as JsonObject | null,
      };
    if (existing) {
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
    const runtimeActor = `agent:runtime-session:${runtimeSessionId}`,
      selfContainedMission =
        taskMission && daemonRoute
          ? assembleTaskMission({
              mission,
              repoId: input.repoId,
              canonicalRoot: input.rootDir,
              workerRoot: cwd,
              taskPackageRoot: taskMission.packageRoot,
              daemonRoute,
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
                daemonRoute,
                runtimeActor,
              })
            : mission,
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
            return createRuntime({
              userRoot: presetUserRoot(input.rootDir),
            }).resolveInternal({
              presetId: agent.preset!,
              verticalId: defaults.verticalId,
              profileId: defaults.profileId,
              locale: defaults.locale,
              purpose: "inspect",
            }).document.body;
          })()
        : undefined,
      fallbackAttempt =
        inheritedFallback ??
        initialFallbackAttempt(agent, explicitRuntimeInstanceId, model, providerSessionId, idempotencyKey, mission),
      fallbackCandidate = fallbackAttempt?.candidates[fallbackAttempt.attemptIndex],
      prompt = agent
        ? assembleAgentPrompt(agent, selfContainedMission ?? mission, preset, resolvedSkills)
        : (selfContainedMission ?? mission),
      selectedModel = fallbackCandidate?.model ?? model ?? agent?.model ?? undefined,
      runtimeSessions = input.remote ? await input.remote.readRuntimeSessions() : projection!.readRuntimeSessions(),
      runtimeInstanceId = await resolveRuntimeInstanceId({
        requested: fallbackCandidate?.instance ?? explicitRuntimeInstanceId,
        providerSessionId: providerSessionId ?? undefined,
        agent,
        model: selectedModel,
        instances: input.runtimeInstances?.() ?? [],
        sessions: runtimeSessions,
      }),
      configuredPermissionMode =
        input.runtimeInstances?.().find((instance) => instance.instanceId === runtimeInstanceId)?.permissionMode ??
        undefined,
      effectivePermissionMode = permissionMode ?? configuredPermissionMode,
      prepared = await input.prepareLaunch(runtimeInstanceId, {
        cwd,
        prompt,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
      }),
      definition = prepared.definition,
      installation = prepared.installation,
      launchedPermissionMode = runtimePermissionMode(effectivePermissionMode, definition.kindId);
    if (agent && !runtimeTypeMatchesKind(agent.runtime_type, definition.kindId))
      throw runtimeSpawnError(
        "agent_runtime_type_mismatch",
        [
          "Agent ",
          `${agent.id}`,
          " requires ",
          `${agent.runtime_type}`,
          ", but instance ",
          `${runtimeInstanceId}`,
          " is ",
          `${definition.kindId}`,
          ".",
        ].join(""),
      );
    if (
      definition.instanceId !== runtimeInstanceId ||
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
    const definitionSnapshotRef = [
        "artifact:runtime-definition/",
        `${createHash("sha256").update(JSON.stringify(definition)).digest("hex")}`,
        "",
      ].join(""),
      runtimeKind = runtimeKindForId(definition.kindId),
      protocolFamily = runtimeKind.protocolFamily,
      workerGitEnvironment = taskId
        ? await prepareWorkerGitEnvironment(runtimeInstanceId)
        : trustedSchedule?.mode === "remediate"
          ? await input.prepareWorkerGitEnvironment?.(runtimeInstanceId)
          : undefined;
    // Enforced runtimes replace HOME and TMPDIR, so a task worker needs the daemon's sealed callback
    // route as well as its own executor identity.
    const workerLaunch =
      (taskId || trustedSchedule) && daemonRoute
        ? {
            ...prepared,
            env: {
              ...prepared.env,
              ...workerGitEnvironment,
              HARNESS_CANONICAL_ROOT: input.rootDir,
              PATH: [
                path.join(input.rootDir, "tools", "git-hooks"),
                prepared.env.PATH ?? globalThis.process?.env.PATH ?? "",
              ]
                .filter(Boolean)
                .join(path.delimiter),
              HARNESS_DAEMON_USER_ROOT: daemonRoute.userRoot,
              HARNESS_DAEMON_ID: daemonRoute.daemonId,
              HARNESS_DAEMON_ENDPOINT: daemonRoute.endpoint,
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
            executionId: remoteTask?.executionId ?? lease!.executionId,
            leaseVersion: lease?.version ?? null,
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
        binding,
        cwd,
        prompt: scrubProviderValue(prompt) as string,
        mission: scrubProviderValue(mission) as string,
        ...(fallbackAttempt ? { fallbackAttempt } : {}),
        ...(promptSource ? { promptSource } : {}),
        model: definition.model,
        reasoningEffort: definition.reasoningEffort,
        resumeProviderSessionId: providerSessionId ?? null,
        ...(onExitCommand ? { onExitCommand } : {}),
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
    if (providerSessionId)
      try {
        openStream();
        process = launch(workerLaunch, { rootDir: input.rootDir, dispatchId: newDispatchId });
        resumeObservation = observeResumeProcess(process, definition.kindId, providerSessionId);
        await resumeObservation.ready;
      } catch (error) {
        process?.terminate();
        process?.release?.();
        removeDispatchStream(input.rootDir, newDispatchId);
        if (runtimeErrorCode(error) === "runtime_resume_failed") throw error;
        consumeKnownError(error);
        throw runtimeSpawnError(
          "runtime_resume_failed",
          `${definition.kindId} session ${providerSessionId} could not be resumed: ${runtimeErrorMessage(error)}`,
        );
      }
    let requested!: Awaited<ReturnType<typeof publishRuntimeEvent>>;
    try {
      await publishRuntimeEvent(
        "runtime_installation_observed",
        {
          installationId: installation.installationId,
          kindId: protocolFamily,
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
      );
    } catch (error) {
      process?.terminate();
      process?.release?.();
      if (stream) removeDispatchStream(input.rootDir, newDispatchId);
      throw error;
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
        },
        `${dispatchOpId}-started`,
        binding,
      );
    } catch (error) {
      process?.terminate();
      process?.release?.();
      if (stream) removeDispatchStream(input.rootDir, newDispatchId);
      throw error;
    }
    if (!process)
      try {
        openStream();
        process = launch(workerLaunch, { rootDir: input.rootDir, dispatchId: newDispatchId });
      } catch (error) {
        removeDispatchStream(input.rootDir, newDispatchId);
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
      delegatedBy,
      squadId: squad?.squadId ?? null,
      parentRuntimeSessionId: parentRuntimeSessionId ?? null,
      binding,
      task: taskBinding,
      schedule: trustedSchedule ?? null,
      cwd,
      prompt,
      ...(promptSource ? { promptSource } : {}),
      onExitCommand: onExitCommand ?? null,
      model: definition.model,
      reasoningEffort: definition.reasoningEffort,
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
    attachActiveRuntime(extracted, active, resumeObservation);
    return requested.receipt
      ? {
          ...requested.receipt,
          runtimeSessionId,
          dispatchId: newDispatchId,
          authorizationDecision: authorizationDecision as unknown as JsonObject | null,
        }
      : {
          ...applied(requested.event, requested.publication!, runtimeSessionId, newDispatchId),
          authorizationDecision: authorizationDecision as unknown as JsonObject | null,
        };
  };
  return {
    spawn: (payload: JsonObject, binding: RuntimeBinding) => spawnAttempt(payload, binding),
    spawnScheduled: (scheduled: TrustedScheduleSpawn, binding: RuntimeBinding) =>
      spawnAttempt(
        {
          runtimeInstanceId: scheduled.runtimeInstanceId,
          agentId: scheduled.agentId,
          prompt: scheduled.mission,
          idempotencyKey: `${scheduled.scheduleId}:${scheduled.claimFence}`,
          cwd: scheduled.cwd ? { scope: "repo-relative", path: scheduled.cwd } : { scope: "repo-root" },
          ...(scheduled.model ? { model: scheduled.model } : {}),
          ...(scheduled.effort ? { effort: scheduled.effort } : {}),
          ...(scheduled.mode === "detect" ? { permissionMode: "read-only" } : {}),
        },
        binding,
        undefined,
        { scheduleId: scheduled.scheduleId, claimFence: scheduled.claimFence, mode: scheduled.mode },
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
  ): Promise<{
    readonly event: RuntimeEventOf<T>;
    readonly publication?: ReturnType<CanonicalEventStore["append"]>;
    readonly receipt?: JsonObject;
  }> {
    return publishRuntimeEventImpl<T>(extracted, type, payload, opId, binding, resultBody);
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
    if (outcome.classification !== "provider_fault" || !fallback) {
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
          binding = header.binding,
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
          const receipt = await spawnAttempt(
            {
              runtimeInstanceId: next.instance,
              ...(header.delegatedByAgentId && header.agentId
                ? { agentId: header.delegatedByAgentId, targetAgentId: header.agentId }
                : header.agentId
                  ? { agentId: header.agentId }
                  : {}),
              ...(header.squadId ? { squadId: header.squadId } : {}),
              ...(header.parentRuntimeSessionId ? { parentRuntimeSessionId: header.parentRuntimeSessionId } : {}),
              ...(next.model ? { model: next.model } : {}),
              ...(header.reasoningEffort ? { effort: header.reasoningEffort } : {}),
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
            binding,
            nextFallback,
            header.schedule,
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
      });
    }, remainingMs);
    timer.unref();
  }
}

function initialFallbackAttempt(
  agent: RuntimeAgent | null,
  requestedInstance: string | undefined,
  requestedModel: string | undefined,
  providerSessionId: string | null | undefined,
  idempotencyKey: string,
  mission: string,
): RuntimeFallbackAttempt | undefined {
  const declared = agent?.fallback;
  if (!declared || providerSessionId) return undefined;
  const requestedIndex =
    requestedInstance === undefined
      ? 0
      : declared.chain.findIndex(
          (candidate) =>
            candidate.instance === requestedInstance &&
            (requestedModel === undefined || candidate.model === undefined || candidate.model === requestedModel),
        );
  if (requestedIndex < 0) return undefined;
  const candidates = declared.chain.slice(requestedIndex),
    digest = createHash("sha256").update(`${agent!.id}\0${idempotencyKey}`).digest("hex");
  return {
    attemptGroupId: `attempt_${digest.slice(0, 24)}`,
    attemptIndex: 0,
    rootIdempotencyKey: idempotencyKey,
    originalMission: mission,
    candidates,
    backoff: declared.backoff,
  };
}

function continuationMission(outcome: RuntimeAttemptOutcome, originalMission: string): string {
  return [
    "# Provider fallback continuation",
    [
      `上次 attempt 用 ${outcome.provider.instance}/${outcome.provider.model} 因 ${outcome.reason} 中断；`,
      "worktree 现状保留在原 cwd；继续同一任务，不使用 provider resume。",
    ].join(""),
    "",
    originalMission,
  ].join("\n");
}
