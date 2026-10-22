import {
  archiveDispatchStream,
  readDispatchStream,
  reopenDispatchStream,
  scrubProviderValue,
} from "./dispatch-stream.ts";
import { isProviderFailureClassification } from "./runtime-fallback-contract.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type {
  ActiveRuntime,
  RuntimeAttemptTerminal,
  RuntimeBinding,
  RuntimeSpawnerInput,
  TrustedScheduleRuntime,
} from "./runtime-spawn-types.ts";
import { runtimeBindingForDispatch } from "./runtime-spawn-types.ts";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import { runtimeErrorMessage, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type { RuntimeAgent, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { resolveRuntimeInstanceCandidates } from "./runtime-spawn-mission.ts";
import { agentRuntimeTargetForKind, agentRuntimeKindMatches } from "./agent-runtime-contract.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";

export function requiredRuntimeFast(value: unknown): boolean {
  if (typeof value !== "boolean") throw runtimeSpawnError("invalid_runtime_fast", "Runtime fast must be a boolean.");
  return value;
}

export function initialFallbackAttempt(
  agent: RuntimeAgent | null,
  requestedInstance: string | undefined,
  requestedModel: string | undefined,
  providerSessionId: string | null | undefined,
  dispatchKey: string,
  /** The dispatch this group's first attempt becomes; a non-branching group is named after it. */
  dispatchId: string,
  mission: string,
  instances: readonly RuntimeInstanceSummary[] = [],
  sessions: readonly RuntimeSessionSelection[] = [],
  allowedInstanceIds?: readonly string[],
  health?: Parameters<typeof resolveRuntimeInstanceCandidates>[0]["health"],
  now?: string,
): RuntimeFallbackAttempt | undefined {
  if (providerSessionId) return undefined;
  const pin = requestedInstance ?? agent?.instance;
  // The candidate list is computed only when no instance was explicitly requested: it is both the
  // anchor source and the availability check a declared pin would otherwise bypass — a declaration
  // whose model or kind no enabled instance can serve fails with agent_model_unavailable here. An
  // explicit request skips it: the operator's pick is validated against the anchor below and by
  // prepareLaunch, and may name an instance the machine store does not list.
  const candidatesForAnchor =
      requestedInstance === undefined
        ? resolveRuntimeInstanceCandidates({
            requested: undefined,
            agent,
            model: requestedModel,
            instances,
            allowedInstanceIds,
            sessions,
            health,
            now,
          })
        : undefined,
    anchorId = pin ?? candidatesForAnchor?.[0],
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
    pin &&
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
      allowedInstanceIds,
      sessions,
      health,
      now,
    }),
    requestedIndex = pin ? derivedInstances.indexOf(pin) : 0,
    candidates = derivedInstances.slice(requestedIndex).map((instanceId) => ({
      instance: instanceId,
      model: candidateModel(instances.find((row) => row.instanceId === instanceId)!),
    }));
  if (requestedIndex < 0) return undefined;
  // A single-candidate group is legitimate (owner ruling 2026-10-21 14:35, T4): with no
  // successor row to switch to, its rounds retry the same instance and stay bounded by
  // providerMaxRetries, so the first provider failure is not the dispatch's last word.
  // The group is named after its first dispatch, which is what a dispatch without a chain
  // already recorded as its own group; a chain only adds attempts to that same identity.
  return {
    attemptGroupId: dispatchId,
    attemptIndex: 0,
    candidateIndex: 0,
    retryRound: 0,
    rootDispatchKey: dispatchKey,
    originalMission: mission,
    candidates,
  };
}

/**
 * The failure info a continuation carries is the attempt outcome's classification, provider, and
 * one-line reason — bounded at settlement and referencing the dispatch stream that keeps the raw
 * provider stderr. It must never inline the previous attempt's raw log, whose size would grow the
 * next mission (and can push it past the next provider's input limit).
 */
export function continuationMission(outcome: RuntimeAttemptOutcome, originalMission: string): string {
  return [
    "# Provider fallback continuation",
    [
      `上次 attempt 用 ${outcome.provider.instance}/${outcome.provider.model} 因 ${outcome.classification} ` +
        `(${outcome.reason}) 中断；`,
      "worktree 现状保留在原 cwd；继续同一任务，不使用 provider resume。",
    ].join(""),
    "",
    originalMission,
  ].join("\n");
}

function fallbackAvailabilitySummary(
  candidates: readonly RuntimeFallbackAttempt["candidates"][number][],
  health: RuntimeSpawnerInput["runtimeProviderHealth"],
): string {
  return candidates
    .map((candidate) => {
      const row = health?.get(candidate.instance),
        recovery = row?.frozen ? "manual解冻" : (row?.frozenUntil ?? row?.cooldownUntil ?? "unknown");
      return `${candidate.instance}: ${row?.reason ?? "provider unavailable"}; recover at ${recovery}`;
    })
    .join("; ");
}

export async function settleFallbackAttempt(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  outcome: RuntimeAttemptOutcome,
  terminal: RuntimeAttemptTerminal,
): Promise<void> {
  const { input } = context;
  const fallback = active.fallbackAttempt;
  if (isProviderFailureClassification(outcome.classification)) {
    const settings = input.readSettings?.(),
      runtime = settings?.runtime;
    input.runtimeProviderHealth?.recordFailure({
      instanceId: outcome.provider.instance,
      reason: outcome.reason,
      occurredAt: input.now(),
      ...(outcome.resetAt ? { resetAt: outcome.resetAt } : {}),
      cooldownBaseSeconds: runtime?.providerCooldownBaseSeconds,
      cooldownMaxSeconds: runtime?.providerCooldownMaxSeconds,
      freezeAfter: runtime?.providerFreezeAfter,
      freezeDurationSeconds: runtime?.providerFreezeDurationSeconds,
      permanentFreeze:
        active.providerFault?.code === "auth_failed" ||
        (active.providerFault?.faultClass === "quota_exhausted" && outcome.resetAt === undefined),
    });
  } else if (active.providerOutcome === "succeeded") {
    input.runtimeProviderHealth?.recordSuccess(outcome.provider.instance, active.startedAt);
  }
  if (!isProviderFailureClassification(outcome.classification) || !fallback) {
    await input.onAttemptTerminal?.(terminal);
    return;
  }
  const currentCandidateIndex = fallback.candidateIndex ?? fallback.attemptIndex,
    nextAttemptIndex = fallback.attemptIndex + 1,
    nextCandidateIndex = currentCandidateIndex + 1,
    retryRound = fallback.retryRound ?? 0,
    runtimeSettings = input.readSettings?.()?.runtime,
    maxRetries = Math.max(0, Number(runtimeSettings?.providerMaxRetries ?? 3)),
    exhausted = nextCandidateIndex >= fallback.candidates.length;
  if (exhausted) {
    if (retryRound < maxRetries) {
      const roundBaseMs = Math.max(0, Number(runtimeSettings?.providerRoundBackoffBaseSeconds ?? 5) * 1_000),
        roundMaxMs = Math.max(roundBaseMs, Number(runtimeSettings?.providerRoundBackoffMaxSeconds ?? 60) * 1_000),
        delayMs = Math.min(roundMaxMs, roundBaseMs * 2 ** retryRound),
        observedAt = Date.parse(input.now()),
        waitStartedAt = fallback.waitStartedAt ? Date.parse(fallback.waitStartedAt) : observedAt,
        maxWaitMs = Math.max(0, Number(runtimeSettings?.providerMaxWaitSeconds ?? 300) * 1_000),
        recoverAt = fallback.candidates.reduce<number | null>((earliest, candidate) => {
          const health = input.runtimeProviderHealth?.get(candidate.instance);
          if (health?.frozen) return earliest;
          const blockedUntil = health?.frozenUntil ?? health?.cooldownUntil,
            blockedMs = blockedUntil ? Date.parse(blockedUntil) : Number.NaN;
          if (!Number.isFinite(blockedMs) || blockedMs <= observedAt) return earliest ?? observedAt;
          return earliest === null ? blockedMs : Math.min(earliest, blockedMs);
        }, null),
        notBeforeAt = new Date(Math.max(observedAt + delayMs, recoverAt ?? observedAt + delayMs)).toISOString(),
        next = fallback.candidates[0]!;
      if (
        Number.isFinite(waitStartedAt) &&
        observedAt - waitStartedAt + Math.max(0, Date.parse(notBeforeAt) - observedAt) > maxWaitMs
      ) {
        const reason =
          `Provider fallback wait budget exhausted after ${String(Math.max(0, observedAt - waitStartedAt))}ms. ` +
          `Candidates: ${fallbackAvailabilitySummary(fallback.candidates, input.runtimeProviderHealth)}`;
        active.stream.appendFallbackState({ state: "exhausted", reason }, input.now());
        await input.onAttemptTerminal?.({ ...terminal, outcome: "failed", reason });
        return;
      }
      if (recoverAt === null) {
        const reason =
          `Provider fallback exhausted: every instance is permanently unavailable after ${String(nextAttemptIndex)} attempt(s). ` +
          `Candidates: ${fallbackAvailabilitySummary(fallback.candidates, input.runtimeProviderHealth)}`;
        active.stream.appendFallbackState({ state: "exhausted", reason }, input.now());
        await input.onAttemptTerminal?.({ ...terminal, outcome: "failed", reason });
        return;
      }
      active.stream.appendFallbackState(
        {
          state: "scheduled",
          delayMs,
          notBeforeAt,
          waitStartedAt: new Date(waitStartedAt).toISOString(),
          nextProvider: next,
        },
        input.now(),
      );
      context.reconcileFallback(readDispatchStream(input.rootDir, active.dispatchId));
      return;
    }
    const reason =
      `Provider fallback exhausted after ${String(nextAttemptIndex)} attempt(s) and ${String(retryRound)} retry round(s): ${outcome.reason}. ` +
      `Candidates: ${fallbackAvailabilitySummary(fallback.candidates, input.runtimeProviderHealth)}`;
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
  const next = fallback.candidates[nextCandidateIndex]!,
    roundBaseMs = Math.max(0, Number(runtimeSettings?.providerRoundBackoffBaseSeconds ?? 5) * 1_000),
    roundMaxMs = Math.max(roundBaseMs, Number(runtimeSettings?.providerRoundBackoffMaxSeconds ?? 60) * 1_000),
    delayMs = Math.min(roundMaxMs, roundBaseMs * 2 ** retryRound),
    observedAt = Date.parse(input.now()),
    resetAt = outcome.classification === "provider_quota" && outcome.resetAt ? Date.parse(outcome.resetAt) : Number.NaN,
    notBeforeAt = new Date(
      Math.max(observedAt + delayMs, Number.isFinite(resetAt) ? resetAt : observedAt),
    ).toISOString();
  active.stream.appendFallbackState({ state: "scheduled", delayMs, notBeforeAt, nextProvider: next }, input.now());
  context.reconcileFallback(readDispatchStream(input.rootDir, active.dispatchId));
}

/** Schedules a settled stream's next fallback attempt: bounded timers from the scheduled
 * notBeforeAt, re-reading the stream at fire time so a superseded schedule never launches.
 * The continuation launch is handed in by the spawner because it is the same spawnAttempt
 * entry every other dispatch takes. */
export function scheduleFallbackContinuation(args: {
  readonly input: RuntimeSpawnerInput;
  readonly closed: () => boolean;
  readonly publishRuntimeEvent: RuntimeSpawnerContext["publishRuntimeEvent"];
  /** The continuation awaits the launch and uses no result. */
  readonly launch: (
    payload: JsonObject,
    binding: RuntimeBinding,
    fallback: RuntimeFallbackAttempt,
    schedule: TrustedScheduleRuntime | undefined,
    handoffFromRuntimeSessionId: string | undefined,
    publicationOwner: ActiveRuntime["publicationOwner"] | undefined,
    onDispatched: (dispatchId: string, runtimeSessionId: string) => void,
  ) => Promise<unknown>;
  readonly stream: ReturnType<typeof readDispatchStream>;
}): void {
  const { input, stream } = args;
  if (
    args.closed() ||
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
  // setTimeout collapses delays above 2^31-1 ms onto 1 ms, so a quota resetAt years out would
  // fire immediately; arm at most the platform maximum and re-check the clock at fire time.
  const timer = setTimeout(
    () => {
      if (args.closed()) return;
      if (Date.parse(input.now()) < notBeforeMs) {
        scheduleFallbackContinuation(args);
        return;
      }
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
          currentCandidateIndex = fallback.candidateIndex ?? fallback.attemptIndex,
          nextCandidateIndex = currentCandidateIndex + 1,
          nextRound = (fallback.retryRound ?? 0) + (nextCandidateIndex >= fallback.candidates.length ? 1 : 0),
          nextFallback = {
            ...fallback,
            attemptIndex: nextAttemptIndex,
            candidateIndex: nextCandidateIndex >= fallback.candidates.length ? 0 : nextCandidateIndex,
            retryRound: nextRound,
            ...(fallback.waitStartedAt ||
            current.fallbackSchedule.waitStartedAt ||
            nextCandidateIndex >= fallback.candidates.length
              ? { waitStartedAt: fallback.waitStartedAt ?? current.fallbackSchedule.waitStartedAt ?? input.now() }
              : {}),
          },
          next = fallback.candidates[nextCandidateIndex >= fallback.candidates.length ? 0 : nextCandidateIndex],
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
              dispatchKey: `${fallback.rootDispatchKey}:fallback:${String(nextAttemptIndex)}`,
            },
            continuationBinding =
              (await input.authorizeRuntimeContinuation?.(
                continuationPayload,
                binding,
                `runtime-continuation:${header.dispatchId}:${nextAttemptIndex}`,
              )) ?? binding;
          await args.launch(
            continuationPayload,
            continuationBinding,
            nextFallback,
            header.schedule,
            header.runtimeSessionId,
            header.publicationOwner,
            (dispatchId, runtimeSessionId) => {
              writer.appendFallbackState(
                { state: "dispatched", nextDispatchId: dispatchId, nextRuntimeSessionId: runtimeSessionId },
                input.now(),
              );
            },
          );
          archiveDispatchStream(input.rootDir, header.dispatchId);
        } catch (error) {
          consumeKnownError(error);
          const reason = String(
            scrubProviderValue(`Provider fallback could not launch ${next.instance}: ${runtimeErrorMessage(error)}`),
          ).slice(0, 1024);
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
            binding,
          });
        }
      }, runtimeBindingForDispatch(stream.header.binding!));
    },
    Math.min(remainingMs, 2_147_483_647),
  );
  timer.unref();
}

/** Reconnects a persisted fallback stream to the spawner's single launch entry point. */
export function reconcileFallback(args: {
  readonly input: RuntimeSpawnerInput;
  readonly publishRuntimeEvent: RuntimeSpawnerContext["publishRuntimeEvent"];
  readonly closed: () => boolean;
  readonly launch: (
    payload: JsonObject,
    binding: RuntimeBinding,
    fallback: RuntimeFallbackAttempt,
    schedule: TrustedScheduleRuntime | undefined,
    handoffFromRuntimeSessionId: string | undefined,
    publicationOwner: ActiveRuntime["publicationOwner"] | undefined,
    onDispatched: (dispatchId: string, runtimeSessionId: string) => void,
  ) => Promise<unknown>;
  readonly stream: ReturnType<typeof readDispatchStream>;
}): void {
  scheduleFallbackContinuation(args);
}
