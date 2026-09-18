import { createHash } from "node:crypto";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type { RuntimeAgent, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { resolveRuntimeInstanceCandidates } from "./runtime-spawn-mission.ts";
import { agentRuntimeTargetForKind, agentRuntimeKindMatches } from "./agent-runtime-contract.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";

export function requiredRuntimeFast(value: unknown): boolean {
  if (typeof value !== "boolean") throw runtimeSpawnError("invalid_runtime_fast", "Runtime fast must be a boolean.");
  return value;
}

export function initialFallbackAttempt(
  agent: RuntimeAgent | null,
  requestedInstance: string | undefined,
  requestedModel: string | undefined,
  providerSessionId: string | null | undefined,
  idempotencyKey: string,
  mission: string,
  instances: readonly RuntimeInstanceSummary[] = [],
  sessions: readonly RuntimeSessionSelection[] = [],
): RuntimeFallbackAttempt | undefined {
  if (providerSessionId) return undefined;
  // The candidate list is computed even when an instance is pinned: it is where a declaration
  // whose model or kind no enabled instance can serve fails with agent_model_unavailable, before
  // the pin would otherwise bypass that check entirely.
  const candidatesForAnchor = resolveRuntimeInstanceCandidates({
      requested: undefined,
      agent,
      model: requestedModel,
      instances,
      sessions,
    }),
    declared = agent?.fallback,
    anchorId = requestedInstance ?? candidatesForAnchor[0],
    anchor = instances.find((instance) => instance.instanceId === anchorId);
  // Each candidate kind resolves its own model: --model override > the runtimes row for
  // that kind > the instance default, so a cross-kind fallback still launches a valid model.
  // A bare dispatch (no Agent declaration) instead pins the anchor's model for the whole
  // chain — provider fallback must never silently change the model.
  const chainModel = requestedModel ?? (agent === null ? anchor?.defaultModel : undefined);
  const candidateModel = (instance: RuntimeInstanceSummary): string =>
    chainModel ?? agentRuntimeTargetForKind(agent?.runtimes ?? [], instance.kindId)?.model ?? instance.defaultModel;
  const model = anchor === undefined ? undefined : candidateModel(anchor);
  if (!anchor || !model) return undefined;
  if (
    requestedInstance &&
    (!anchor.enabled ||
      !anchor.models.includes(model) ||
      (anchor.authReadiness.status !== "ready" && anchor.authReadiness.code !== "runtime_auth_not_checked") ||
      (agent !== null && !agentRuntimeKindMatches(agent.runtimes, anchor.kindId)))
  )
    return undefined;
  const derivedInstances = resolveRuntimeInstanceCandidates({
      requested: undefined,
      agent,
      model: chainModel,
      runtimeKind: agent === null ? anchor.kindId : undefined,
      instances,
      sessions,
    }),
    requestedIndex = requestedInstance ? derivedInstances.indexOf(requestedInstance) : 0,
    candidates = derivedInstances.slice(requestedIndex).map((instanceId) => ({
      instance: instanceId,
      model: candidateModel(instances.find((row) => row.instanceId === instanceId)!),
    }));
  if (requestedIndex < 0) return undefined;
  if (candidates.length < 2) return undefined;
  const backoff = declared?.backoff ?? { baseMs: 0, maxMs: 0 },
    digest = createHash("sha256")
      .update(`${agent?.id ?? requestedInstance ?? "runtime"}\0${idempotencyKey}`)
      .digest("hex");
  return {
    attemptGroupId: `attempt_${digest.slice(0, 24)}`,
    attemptIndex: 0,
    rootIdempotencyKey: idempotencyKey,
    originalMission: mission,
    candidates,
    backoff,
  };
}

export function continuationMission(outcome: RuntimeAttemptOutcome, originalMission: string): string {
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
