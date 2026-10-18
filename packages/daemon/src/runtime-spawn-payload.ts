import { runtimeSessionIdFromActor } from "@harness-anything/kernel";
import type { RuntimeHandoffCheckpoint } from "./runtime-handoff-store.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { assertResumeAgent, resolveRuntimeResume } from "./runtime-resume-admission.ts";
import { requiredRuntimeFast } from "./runtime-spawn-fallback.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { decisionReviewTarget as parseDecisionReviewTarget, runtimeMissionName } from "./runtime-spawn-mission.ts";
import type { RuntimeBinding, RuntimeSpawnerInput } from "./runtime-spawn-types.ts";

/** Parses and validates one raw spawn payload into the typed request every launch path dispatches against. */
export function parseRuntimeSpawnRequest(
  input: RuntimeSpawnerInput,
  payload: JsonObject,
  binding: RuntimeBinding,
  handoff?: RuntimeHandoffCheckpoint,
) {
  const dryRun = payload.dryRun === true;
  const { requestedDispatchId, resumed, inherited, handoffEnabled } = resolveRuntimeResume(input, payload, handoff);
  const explicitRuntimeInstanceId =
      payload.runtimeInstanceId === undefined
        ? inherited?.instanceId
        : requiredRuntimeSpawnText(payload.runtimeInstanceId, "runtimeInstanceId"),
    explicitMission = payload.prompt === undefined ? undefined : requiredRuntimeSpawnText(payload.prompt, "prompt"),
    missionName = payload.missionName === undefined ? undefined : runtimeMissionName(payload.missionName),
    agentId = payload.agentId === undefined ? inherited?.agentId : requiredRuntimeSpawnText(payload.agentId, "agentId"),
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
  return {
    dryRun,
    requestedDispatchId,
    resumed,
    inherited,
    handoffEnabled,
    explicitRuntimeInstanceId,
    explicitMission,
    missionName,
    agentId,
    targetAgentId,
    squadId,
    role,
    parentRuntimeSessionId,
    model,
    effort,
    fast,
    permissionMode,
    promptSource,
    onExitCommand,
    dispatchKey,
    taskId,
    requestedExecutionId,
    decisionReviewTarget,
    providerSessionId,
  };
}
