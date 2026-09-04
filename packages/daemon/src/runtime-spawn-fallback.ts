import { createHash } from "node:crypto";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type { RuntimeAgent } from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";

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
