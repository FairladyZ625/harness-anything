import { agentRuntimeTargetForKind } from "./agent-runtime-contract.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { resolveDispatchAgent } from "./runtime-spawn-agent.ts";
import { dispatchCallbackRelay } from "./runtime-callback-relay.ts";
import type { RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { initialFallbackAttempt } from "./runtime-spawn-fallback.ts";
import {
  assembleAgentPrompt,
  assembleScheduledMission,
  assembleTaskMission,
  assembleUnboundPrompt,
  dispatchMissionForPermission,
} from "./runtime-spawn-mission.ts";
import type {
  RuntimeDaemonRoute,
  RuntimeSessionSelection,
  RuntimeSpawnerInput,
  TrustedScheduleRuntime,
} from "./runtime-spawn-types.ts";
import type { RuntimeProviderHealth } from "./runtime-provider-health.ts";
import { scheduleMissionWithOutcomeProtocol } from "./schedule-runtime-outcome.ts";
import { taskWorktreeCheckoutNote, type TaskWorktreeCheckout } from "./task-worktree.ts";

/** Everything one launch assembly reads from the spawning dispatch; captured once per spawn attempt. */
export interface RuntimeLaunchScope {
  readonly input: RuntimeSpawnerInput;
  readonly dryRun: boolean;
  readonly inheritedFallback: RuntimeFallbackAttempt | undefined;
  readonly agent: ReturnType<typeof resolveDispatchAgent>["agent"];
  readonly explicitRuntimeInstanceId: string | undefined;
  readonly model: string | undefined;
  readonly providerSessionId: string | null | undefined;
  readonly dispatchKey: string;
  readonly mission: string;
  readonly runtimeInstances: readonly RuntimeInstanceSummary[];
  readonly localRuntimeSessions: readonly RuntimeSessionSelection[];
  readonly allowedInstanceIds: readonly string[] | undefined;
  readonly providerHealth: readonly RuntimeProviderHealth[];
  readonly daemonRoute: RuntimeDaemonRoute | undefined;
  readonly newDispatchId: string;
  readonly runtimeSessionId: string;
  readonly taskMission: { readonly mission: string; readonly packageRoot: string } | null;
  readonly dispatchWorktree: TaskWorktreeCheckout | null;
  readonly cwd: string;
  readonly taskId: string | null;
  readonly role: string | undefined;
  readonly trustedSchedule: TrustedScheduleRuntime | undefined;
  readonly runtimeActor: string;
  readonly permissionMode: string | undefined;
  readonly effort: string | undefined;
  readonly fast: boolean | undefined;
  readonly preset: ReturnType<typeof resolveDispatchAgent>["preset"];
  readonly resolvedSkills: ReturnType<typeof resolveDispatchAgent>["resolvedSkills"];
}

/** Assembles the launch for one candidate runtime instance: fallback bookkeeping, callback relay,
 * self-contained mission, effective permission mode, prompt, and the prepared launch — or, on a
 * dry run, the preview that ends exactly at this boundary. Invoked once per candidate by
 * prepareRuntimeInstance until one succeeds. */
export async function assembleRuntimeLaunch(runtimeInstanceId: string, scope: RuntimeLaunchScope) {
  const {
    input,
    dryRun,
    inheritedFallback,
    agent,
    explicitRuntimeInstanceId,
    model,
    providerSessionId,
    dispatchKey,
    mission,
    runtimeInstances,
    localRuntimeSessions,
    allowedInstanceIds,
    providerHealth,
    daemonRoute,
    newDispatchId,
    runtimeSessionId,
    taskMission,
    dispatchWorktree,
    cwd,
    taskId,
    role,
    trustedSchedule,
    runtimeActor,
    permissionMode,
    effort,
    fast,
    preset,
    resolvedSkills,
  } = scope;
  const initialFallback =
      inheritedFallback ??
      initialFallbackAttempt(
        agent,
        explicitRuntimeInstanceId,
        model,
        providerSessionId,
        dispatchKey,
        mission,
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
            mission,
            runtimeInstances,
            localRuntimeSessions,
            allowedInstanceIds,
            providerHealth,
            input.now(),
          )
        : initialFallback,
    fallbackAttemptForDispatch = fallbackAttempt,
    fallbackCandidate =
      fallbackAttemptForDispatch?.candidates[
        fallbackAttemptForDispatch.candidateIndex ?? fallbackAttemptForDispatch.attemptIndex
      ],
    runtimeInstance = runtimeInstances.find((instance) => instance.instanceId === runtimeInstanceId),
    selectedModel =
      fallbackCandidate?.model ??
      model ??
      (agent && runtimeInstance ? agentRuntimeTargetForKind(agent.runtimes, runtimeInstance.kindId)?.model : undefined),
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
  const preview = dryRun
      ? {
          schema: "agent-dispatch-preview/v1",
          ok: true,
          command: "runtime-spawn",
          dispatchId: newDispatchId,
          runtimeSessionId,
          prompt,
          mission,
        }
      : null,
    prepared = dryRun
      ? null
      : await input.prepareLaunch(runtimeInstanceId, {
          cwd,
          prompt,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(effort ? { effort } : {}),
          ...(fast === undefined ? {} : { fast }),
          ...(declaredPermissionMode ? { permissionMode: declaredPermissionMode } : {}),
          ...(providerSessionId ? { providerSessionId } : {}),
          runtimeSessionId,
          handshakeTimeoutMs: input.readSettings?.().runtime.providerHandshakeTimeoutMs,
        }),
    result = {
      fallbackAttempt: fallbackAttemptForDispatch,
      runtimeInstance,
      effectivePermissionMode,
      callbackRelay,
      readOnlyDispatch,
      prompt,
      prepared,
      preview,
    };
  return result;
}

export type RuntimeLaunchSelection = Awaited<ReturnType<typeof assembleRuntimeLaunch>>;
