import { createHash } from "node:crypto";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { continuationMission } from "./runtime-spawn-fallback.ts";
import { runtimeErrorMessage } from "./runtime-spawn-errors.ts";
import type {
  ActiveRuntime,
  RuntimeAttemptTerminal,
  RuntimeBinding,
  RuntimeSpawnerInput,
  TrustedScheduleRuntime,
} from "./runtime-spawn-types.ts";

// A provider 429 whose reset lands within this window is waited out and retried on the same
// provider (at most `rateLimitRetryBudget` times per attempt group); a longer window settles
// provider_quota immediately instead of parking the dispatch. The budget lives in memory: a
// daemon restart forgets it, which only means the next attempt group gets a fresh budget.
const rateLimitRetryWindowCapMs = 120_000;
const rateLimitRetryBudget = 3;
const rateLimitRetriesByGroup = new Map<string, number>();

export interface ProviderRateLimitRetryPlan {
  readonly delayMs: number;
  readonly notBeforeAt: string;
}

export function rateLimitRetryPlan(outcome: RuntimeAttemptOutcome): ProviderRateLimitRetryPlan | null {
  if (outcome.classification !== "provider_quota" || outcome.faultClass !== "rate_limited") return null;
  if (typeof outcome.resetAt !== "string") return null;
  const resetMs = Date.parse(outcome.resetAt);
  if (!Number.isFinite(resetMs)) return null;
  const delayMs = resetMs - Date.now();
  if (delayMs < 0 || delayMs > rateLimitRetryWindowCapMs) return null;
  const spent = rateLimitRetriesByGroup.get(outcome.attemptGroupId) ?? 0;
  if (spent >= rateLimitRetryBudget) return null;
  rateLimitRetriesByGroup.set(outcome.attemptGroupId, spent + 1);
  return { delayMs, notBeforeAt: outcome.resetAt };
}

function rateRetryGroupId(dispatchId: string): string {
  return `attempt_${createHash("sha256").update(dispatchId).digest("hex").slice(0, 24)}`;
}

export type ProviderRateLimitRetryDeps = Pick<
  RuntimeSpawnerInput,
  "now" | "schedule" | "rootDir" | "authorizeRuntimeContinuation" | "onAttemptTerminal"
> & {
  readonly fallbackClosed: () => boolean;
  readonly spawnAttempt: (
    payload: JsonObject,
    binding: RuntimeBinding,
    inheritedFallback?: RuntimeFallbackAttempt,
    trustedSchedule?: TrustedScheduleRuntime,
    handoffFromRuntimeSessionId?: string,
    retainCoordinatorTaskLease?: boolean,
    publicationOwner?: ActiveRuntime["publicationOwner"],
  ) => Promise<JsonObject>;
};

/**
 * A rate-limited attempt whose provider reset is seconds away is waited out and the same
 * provider retried instead of settling the dispatch failed: simultaneous workers on one
 * instance otherwise each burn a whole run on a 429 whose window closes before a manual
 * resume could even be issued.
 */
export function scheduleProviderRateLimitRetry(
  deps: ProviderRateLimitRetryDeps,
  active: ActiveRuntime,
  outcome: RuntimeAttemptOutcome,
  terminal: RuntimeAttemptTerminal,
  plan: ProviderRateLimitRetryPlan,
  fallback: RuntimeFallbackAttempt | null,
): void {
  active.stream.appendFallbackState(
    {
      state: "scheduled",
      delayMs: plan.delayMs,
      notBeforeAt: plan.notBeforeAt,
      nextProvider: { instance: outcome.provider.instance, model: outcome.provider.model },
    },
    deps.now(),
  );
  const timer = setTimeout(() => {
    if (deps.fallbackClosed()) {
      void deps.onAttemptTerminal?.(terminal);
      return;
    }
    deps.schedule(async () => {
      const retryFallback: RuntimeFallbackAttempt =
          fallback !== null
            ? {
                ...fallback,
                attemptIndex: fallback.attemptIndex + 1,
                candidates: [
                  ...fallback.candidates,
                  { instance: outcome.provider.instance, model: outcome.provider.model },
                ],
              }
            : {
                attemptGroupId: rateRetryGroupId(active.dispatchId),
                attemptIndex: 1,
                rootIdempotencyKey: `${active.dispatchId}:rate-retry`,
                originalMission: active.prompt,
                candidates: [
                  { instance: outcome.provider.instance, model: outcome.provider.model },
                  { instance: outcome.provider.instance, model: outcome.provider.model },
                ],
                backoff: { baseMs: 0, maxMs: 0 },
              },
        payload: JsonObject = {
          runtimeInstanceId: outcome.provider.instance,
          ...(active.agent?.id && active.delegatedBy
            ? { agentId: active.delegatedBy.id, targetAgentId: active.agent.id }
            : active.agent?.id
              ? { agentId: active.agent.id }
              : {}),
          ...(active.role ? { role: active.role } : {}),
          ...(active.squadId ? { squadId: active.squadId } : {}),
          ...(active.parentRuntimeSessionId ? { parentRuntimeSessionId: active.parentRuntimeSessionId } : {}),
          model: outcome.provider.model,
          ...(active.reasoningEffort ? { effort: active.reasoningEffort } : {}),
          ...(active.fast === undefined ? {} : { fast: active.fast }),
          ...(active.permissionMode ? { permissionMode: active.permissionMode } : {}),
          cwd:
            active.cwd === deps.rootDir
              ? { scope: "repo-root" }
              : { scope: "repo-relative", path: path.relative(deps.rootDir, active.cwd) },
          prompt: continuationMission(outcome, active.prompt),
          ...(active.promptSource ? { promptSource: active.promptSource } : {}),
          ...(active.onExitCommand ? { onExitCommand: active.onExitCommand } : {}),
          ...(active.task ? { taskId: active.task.taskId } : {}),
          idempotencyKey: `${retryFallback.rootIdempotencyKey}:rate-retry:${String(retryFallback.attemptIndex)}`,
        },
        continuationBinding =
          deps.authorizeRuntimeContinuation?.(
            payload,
            active.binding,
            `runtime-continuation:${active.dispatchId}:${String(retryFallback.attemptIndex)}`,
          ) ?? active.binding;
      try {
        const receipt = await deps.spawnAttempt(
          payload,
          continuationBinding,
          retryFallback,
          active.schedule ?? undefined,
          active.runtimeSessionId,
          active.task !== null && active.binding.actor.executor?.id !== `runtime-session:${active.runtimeSessionId}`,
          active.publicationOwner,
        );
        active.stream.appendFallbackState(
          {
            state: "dispatched",
            nextDispatchId: String(receipt.dispatchId),
            nextRuntimeSessionId: String(receipt.runtimeSessionId),
          },
          deps.now(),
        );
      } catch (error) {
        consumeKnownError(error);
        const reason =
          `Provider rate-limit retry could not launch ${outcome.provider.instance}: ` + runtimeErrorMessage(error);
        active.stream.appendFallbackState({ state: "exhausted", reason }, deps.now());
        await deps.onAttemptTerminal?.({ ...terminal, outcome: "failed", reason });
      }
    }, active.binding);
  }, plan.delayMs);
  timer.unref();
}
