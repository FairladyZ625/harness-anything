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
import { createHash } from "node:crypto";
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
  idempotencyKey: string,
  mission: string,
  instances: readonly RuntimeInstanceSummary[] = [],
  sessions: readonly RuntimeSessionSelection[] = [],
  allowedInstanceIds: readonly string[] = [],
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
          })
        : undefined,
    declared = agent?.fallback,
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
    }),
    requestedIndex = pin ? derivedInstances.indexOf(pin) : 0,
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

export async function settleFallbackAttempt(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  outcome: RuntimeAttemptOutcome,
  terminal: RuntimeAttemptTerminal,
): Promise<void> {
  const { input } = context;
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
  context.reconcileFallback(readDispatchStream(input.rootDir, active.dispatchId));
}

/** Schedules a settled stream's next fallback attempt: one bounded timer from the scheduled
 * notBeforeAt, re-reading the stream at fire time so a superseded schedule never launches.
 * The continuation launch is handed in by the spawner because it is the same spawnAttempt
 * entry every other dispatch takes. */
export function scheduleFallbackContinuation(args: {
  readonly input: RuntimeSpawnerInput;
  readonly closed: () => boolean;
  readonly publishRuntimeEvent: RuntimeSpawnerContext["publishRuntimeEvent"];
  readonly launch: (
    payload: JsonObject,
    binding: RuntimeBinding,
    fallback: RuntimeFallbackAttempt,
    schedule: TrustedScheduleRuntime | undefined,
    handoffFromRuntimeSessionId: string | undefined,
    publicationOwner: ActiveRuntime["publicationOwner"] | undefined,
    onDispatched: (dispatchId: string, runtimeSessionId: string) => void,
  ) => Promise<void>;
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
  const timer = setTimeout(() => {
    if (args.closed()) return;
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
        const terminal = current.terminalOutcome;
        if (terminal) {
          const payload = {
            ...terminal.payload,
            attempt: {
              classification: current.attemptOutcome.classification,
              reason,
              ...(current.attemptOutcome.faultClass ? { faultClass: current.attemptOutcome.faultClass } : {}),
              ...(current.attemptOutcome.resetAt ? { resetAt: current.attemptOutcome.resetAt } : {}),
              fallbackState: "exhausted" as const,
            },
          };
          writer.appendTerminalOutcome({ ...terminal, payload, reason }, input.now());
          await args.publishRuntimeEvent(
            "runtime_session_outcome_observed",
            payload,
            `${header.dispatchOpId}-fallback-exhausted`,
            binding,
            terminal.body,
          );
        }
      }
    }, runtimeBindingForDispatch(stream.header.binding!));
  }, remainingMs);
  timer.unref();
}
