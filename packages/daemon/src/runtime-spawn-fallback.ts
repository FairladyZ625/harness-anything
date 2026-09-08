import { createHash } from "node:crypto";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type { RuntimeAgent, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { resolveRuntimeInstanceCandidates } from "./runtime-spawn-mission.ts";
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
  const declared = agent?.fallback;
  const anchor = requestedInstance
    ? instances.find((instance) => instance.instanceId === requestedInstance)
    : instances.find(
        (instance) =>
          instance.instanceId ===
          resolveRuntimeInstanceCandidates({
            requested: undefined,
            agent,
            model: requestedModel ?? agent?.model,
            instances,
            sessions,
          })[0],
      );
  const model = requestedModel ?? agent?.model ?? anchor?.defaultModel;
  if (!anchor || !model) return undefined;
  const runtimeType = agent?.runtime_type === "any" ? anchor.kindId : (agent?.runtime_type ?? anchor.kindId);
  if (
    requestedInstance &&
    (!anchor.enabled ||
      !anchor.models.includes(model) ||
      (anchor.authReadiness.status !== "ready" && anchor.authReadiness.code !== "runtime_auth_not_checked") ||
      (runtimeType !== "any" && runtimeType !== anchor.kindId))
  )
    return undefined;
  const derivedInstances = resolveRuntimeInstanceCandidates({
      requested: undefined,
      agent,
      model,
      runtimeType,
      instances,
      sessions,
    }),
    requestedIndex = requestedInstance ? derivedInstances.indexOf(requestedInstance) : 0,
    candidates = derivedInstances.slice(requestedIndex).map((instance) => ({ instance, model }));
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
