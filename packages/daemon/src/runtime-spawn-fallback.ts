import {
  archiveDispatchStream,
  readDispatchStream,
  reopenDispatchStream,
  scrubProviderValue,
  type DispatchTerminalOutcome,
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
import { createHash } from "node:crypto";
import { consumeKnownError, type AgentRuntimeEventV1, type DispatchLifecycleView } from "@harness-anything/kernel";
import { readDispatchLifecycle } from "./runtime-dispatch-admission.ts";
import { runtimeErrorMessage, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type { RuntimeAgent, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { resolveRuntimeInstanceCandidates } from "./runtime-spawn-mission.ts";
import { reclaimReviewWorktree } from "./task-worktree.ts";
import {
  agentRuntimeModelMatches,
  agentRuntimeTargetForKind,
  agentRuntimeKindMatches,
} from "./agent-runtime-contract.ts";
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
  /** An auto-selected anchor must still keep candidates that sort before it as successors. */
  includeCandidatesBeforePin = false,
): RuntimeFallbackAttempt | undefined {
  // A resumed dispatch inherits its provider session's instance, and its fallback continuation is a
  // fresh session, never a resume: the chain still belongs to this dispatch. Anchoring it at the
  // resumed instance keeps the provider that just failed as attempt 0 and lets later attempts switch
  // providers like a fresh dispatch. Without this a resumed dispatch had no chain at all, so the same
  // provider fault that switched providers on a fresh dispatch ended the resumed one outright.
  // A resumed session the projection does not carry cannot anchor that chain — a guessed anchor would
  // record attempt 0 under a provider that never ran — so it keeps the pre-existing no-chain behavior.
  const resumedInstanceId = providerSessionId
    ? sessions.find((session) => session.providerSessionId === providerSessionId)?.instanceId
    : undefined;
  if (providerSessionId && resumedInstanceId === undefined) return undefined;
  // A declared instance preference does not re-route an already-admitted session — resume admission
  // accepted that provider and the launch resumes it — but it still anchors fresh dispatches.
  const pin = resumedInstanceId === undefined ? (requestedInstance ?? agent?.instance) : undefined,
    anchorId = resumedInstanceId ?? requestedInstance ?? agent?.instance;
  // The candidate list is computed only when nothing anchored the chain: it is both the anchor source
  // and the availability check an anchor would otherwise bypass — a declaration whose model or kind no
  // enabled instance can serve fails with agent_model_unavailable here. An explicit or resumed anchor
  // skips it: that provider is validated below and by prepareLaunch / resume admission.
  const candidatesForAnchor =
      anchorId === undefined
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
    anchor = instances.find((instance) => instance.instanceId === (anchorId ?? candidatesForAnchor?.[0]));
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
      !agentRuntimeModelMatches(anchor.models, model) ||
      (anchor.authReadiness.status !== "ready" && anchor.authReadiness.code !== "runtime_auth_not_checked") ||
      (agent !== null && !agentRuntimeKindMatches(agent.runtimes, anchor.kindId)))
  )
    return undefined;
  // A resumed provider may sit outside the availability filter (resume admission admitted it, and the
  // launch resumes it whether or not it is enabled or cooling down now), so it leads the chain and is
  // not repeated among the instances this dispatch would fall back to.
  const derivedInstances = resolveRuntimeInstanceCandidates({
      requested: undefined,
      agent,
      model: chainModel,
      runtimeKind: agent === null ? anchor.kindId : undefined,
      instances,
      allowedInstanceIds,
      sessions,
      // Health is a selection-time signal, never chain membership: a candidate cooling when the
      // dispatch starts must stay in the chain so settle can wait for its recovery. The anchor
      // above still uses health, because the first attempt has to launch now.
      health: undefined,
      now,
    }).filter((instanceId) => instanceId !== resumedInstanceId),
    configuredInstances = allowedInstanceIds?.filter((instanceId) => derivedInstances.includes(instanceId)),
    fallbackOrder = configuredInstances ?? derivedInstances,
    requestedIndex = pin ? fallbackOrder.indexOf(pin) : -1,
    // A user-pinned attempt starts its fallback chain at its configured allowlist position;
    // providers before it are not successors. An auto-selected anchor has no such exclusion:
    // a cooling candidate that sorts before it is still a declared fallback.
    successors =
      includeCandidatesBeforePin && pin !== undefined
        ? derivedInstances.filter((instanceId) => instanceId !== pin)
        : pin === undefined || requestedIndex < 0
          ? derivedInstances
          : fallbackOrder.slice(requestedIndex + 1),
    candidates = [
      ...(pin === undefined ? [] : [pin]),
      ...(resumedInstanceId === undefined ? [] : [resumedInstanceId]),
      ...successors,
    ].map((instanceId) => ({
      instance: instanceId,
      model: candidateModel(instances.find((row) => row.instanceId === instanceId)!),
    }));
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

interface NextFallbackCandidate {
  readonly index: number;
  /** Epoch ms when a cooling candidate becomes usable; null when the candidate is usable now. */
  readonly recoverAt: number | null;
}

/**
 * Select the next fallback candidate using health as a filter, not as chain membership.
 * Permanently frozen rows are skipped; the first usable row in chain order wins. When every
 * remaining row is cooling, the soonest recovery is selected so settle can wait for it.
 */
function nextFallbackCandidate(
  candidates: RuntimeFallbackAttempt["candidates"],
  fromIndex: number,
  health: RuntimeSpawnerInput["runtimeProviderHealth"],
  observedAt: number,
): NextFallbackCandidate | null {
  let cooling: NextFallbackCandidate | null = null;
  for (let index = fromIndex; index < candidates.length; index += 1) {
    const row = health?.get(candidates[index]!.instance);
    if (row?.frozen) continue;
    const blockedUntil = row?.frozenUntil ?? row?.cooldownUntil,
      blockedMs = blockedUntil ? Date.parse(blockedUntil) : Number.NaN;
    if (!Number.isFinite(blockedMs) || blockedMs <= observedAt) return { index, recoverAt: null };
    if (cooling === null || blockedMs < cooling.recoverAt!) cooling = { index, recoverAt: blockedMs };
  }
  return cooling;
}

export type FallbackSettlement = Pick<
  NonNullable<Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>["payload"]["attempt"]>,
  "fallbackState" | "fallbackSchedule"
>;

export async function settleFallbackAttempt(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  outcome: RuntimeAttemptOutcome,
  terminal: RuntimeAttemptTerminal,
): Promise<FallbackSettlement | void> {
  const { input } = context;
  const exhaustedTerminal = async (reason: string): Promise<FallbackSettlement> => {
    active.stream.appendFallbackState({ state: "exhausted", reason }, input.now());
    await input.onAttemptTerminal?.({ ...terminal, outcome: "failed", reason });
    return { fallbackState: "exhausted" };
  };
  const scheduledTerminal = (
    schedule: NonNullable<FallbackSettlement["fallbackSchedule"]>,
    delayMs: number,
  ): FallbackSettlement => {
    active.stream.appendFallbackState({ state: "scheduled", ...schedule, delayMs }, input.now());
    return { fallbackState: "scheduled", fallbackSchedule: schedule };
  };
  const fallback = active.fallbackAttempt;
  // A delivered attempt is not a provider failure, whatever its tail looked like: an accepted
  // submission or registered review is work the provider did complete, so it keeps the success
  // disposition it had before that tail was labelled (a drained reconnect is evidence about the
  // ending, not a reason to re-run a delivery).
  const delivered = terminal.outcome === "succeeded";
  if (isProviderFailureClassification(outcome.classification) && !delivered) {
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
  } else if (active.providerOutcome === "succeeded" || delivered) {
    input.runtimeProviderHealth?.recordSuccess(outcome.provider.instance, active.startedAt);
  }
  if (delivered || !isProviderFailureClassification(outcome.classification) || !fallback) {
    await input.onAttemptTerminal?.(terminal);
    return;
  }
  const currentCandidateIndex = fallback.candidateIndex ?? fallback.attemptIndex,
    nextAttemptIndex = fallback.attemptIndex + 1,
    nextCandidateIndex = currentCandidateIndex + 1,
    retryRound = fallback.retryRound ?? 0,
    runtimeSettings = input.readSettings?.()?.runtime,
    maxRetries = Math.max(0, Number(runtimeSettings?.providerMaxRetries ?? 3)),
    observedAt = Date.parse(input.now()),
    selection =
      nextCandidateIndex >= fallback.candidates.length
        ? null
        : nextFallbackCandidate(fallback.candidates, nextCandidateIndex, input.runtimeProviderHealth, observedAt),
    // No usable candidate in this pass. The exhausted branch either waits out a retry round
    // (including candidates that recover later) or settles permanently unavailable.
    exhausted = selection === null;
  const recoverAt = exhausted
    ? fallback.candidates.reduce<number | null>((earliest, candidate) => {
        const health = input.runtimeProviderHealth?.get(candidate.instance);
        if (health?.frozen) return earliest;
        const blockedUntil = health?.frozenUntil ?? health?.cooldownUntil,
          blockedMs = blockedUntil ? Date.parse(blockedUntil) : Number.NaN,
          usableAt = Number.isFinite(blockedMs) ? Math.max(observedAt, blockedMs) : observedAt;
        return earliest === null ? usableAt : Math.min(earliest, usableAt);
      }, null)
    : selection!.recoverAt;
  if (exhausted && (retryRound >= maxRetries || recoverAt === null))
    return exhaustedTerminal(
      `Provider fallback exhausted after ${String(nextAttemptIndex)} attempt(s) and ${String(retryRound)} retry round(s): ${outcome.reason}. ` +
        `Candidates: ${fallbackAvailabilitySummary(fallback.candidates, input.runtimeProviderHealth)}`,
    );
  const next = fallback.candidates[exhausted ? 0 : selection!.index]!,
    roundBaseMs = Math.max(0, Number(runtimeSettings?.providerRoundBackoffBaseSeconds ?? 5) * 1_000),
    roundMaxMs = Math.max(roundBaseMs, Number(runtimeSettings?.providerRoundBackoffMaxSeconds ?? 60) * 1_000),
    delayMs = Math.min(roundMaxMs, roundBaseMs * 2 ** retryRound),
    resetAt =
      !exhausted && outcome.classification === "provider_quota" && outcome.resetAt
        ? Date.parse(outcome.resetAt)
        : Number.NaN,
    notBeforeMs = Math.max(observedAt + delayMs, Number.isFinite(resetAt) ? resetAt : observedAt, recoverAt ?? 0),
    waitStartedAt = fallback.waitStartedAt
      ? Date.parse(fallback.waitStartedAt)
      : exhausted || recoverAt !== null
        ? observedAt
        : null,
    maxWaitMs = Math.max(0, Number(runtimeSettings?.providerMaxWaitSeconds ?? 300) * 1_000);
  if (waitStartedAt !== null && observedAt - waitStartedAt + Math.max(0, notBeforeMs - observedAt) > maxWaitMs)
    return exhaustedTerminal(
      `Provider fallback wait budget exhausted after ${String(Math.max(0, observedAt - waitStartedAt))}ms. ` +
        `Candidates: ${fallbackAvailabilitySummary(fallback.candidates, input.runtimeProviderHealth)}`,
    );
  return scheduledTerminal(
    {
      notBeforeAt: new Date(notBeforeMs).toISOString(),
      nextProvider: next,
      ...(waitStartedAt === null ? {} : { waitStartedAt: new Date(waitStartedAt).toISOString() }),
    },
    delayMs,
  );
}

/** Timers only wake the scheduler; the center's current leaf and accepted schedule authorize launch. */
export async function scheduleFallbackContinuation(args: {
  readonly context: RuntimeSpawnerContext;
  readonly launch: (
    payload: JsonObject,
    binding: RuntimeBinding,
    fallback: RuntimeFallbackAttempt,
    schedule: TrustedScheduleRuntime | undefined,
    handoffFromRuntimeSessionId: string | undefined,
    publicationOwner: ActiveRuntime["publicationOwner"] | undefined,
    onDispatched: (dispatchId: string, runtimeSessionId: string) => void,
  ) => Promise<unknown>;
  readonly dispatchId: string;
}): Promise<void> {
  const { context } = args,
    { input } = context;
  if (context.closed?.()) return;
  const read = await readDispatchLifecycle(context, { by: "dispatch", dispatchIds: [args.dispatchId] });
  if (read.status !== "ready")
    throw runtimeSpawnError("dispatch_lifecycle_pending", "Fallback lifecycle is not ready.");
  const lifecycle = read.rows[0];
  if (!lifecycle?.policy.fallbackPending || lifecycle.controlLeafDispatchId !== args.dispatchId) return;
  const stream = readDispatchStream(input.rootDir, args.dispatchId);
  if (!stream?.header.binding || !stream.header.fallbackAttempt || !stream.attemptOutcome || !stream.header.cwd) return;
  const header = stream.header,
    binding = runtimeBindingForDispatch(header.binding!),
    writer = reopenDispatchStream(input.rootDir, header);
  const publishTerminal = async (terminal: DispatchTerminalOutcome) => {
    const result = await context.publishRuntimeEvent(
      "runtime_session_outcome_observed",
      terminal.payload,
      `fallback-terminal-${createHash("sha256").update(JSON.stringify(terminal)).digest("hex")}`,
      binding,
      terminal.body,
    );
    const settled = await readDispatchLifecycle(context, { by: "dispatch", dispatchIds: [header.dispatchId] });
    if (settled.status !== "ready")
      throw runtimeSpawnError("dispatch_lifecycle_pending", "Fallback lifecycle is not ready.");
    if (!settled.rows[0]?.policy.groupSettled) return false;
    writer.appendFallbackState({ state: "exhausted", reason: terminal.reason }, input.now());
    if (result.event) input.onRuntimeOutcome?.(result.event, header.schedule ?? null);
    await input.onAttemptTerminal?.({
      runtimeSessionId: header.runtimeSessionId,
      dispatchId: header.dispatchId,
      task: null,
      schedule: header.schedule ?? null,
      outcome: "failed",
      reason: terminal.reason,
      endedAt: terminal.payload.endedAt ?? input.now(),
      binding,
    });
    await releaseFallbackResources(context, settled.rows[0], header.role, header.cwd);
    return true;
  };
  // Replay durable event bytes first; only the center decides whether they close the group.
  if (stream.terminalOutcome && (await publishTerminal(stream.terminalOutcome))) return;
  // Previous-version outcomes did not carry the plan. Decode their launch data from the spool
  // during the current/previous protocol window (expires 2026-12-07); state still comes from the reducer.
  const plan = lifecycle.successor.schedule ?? stream.fallbackSchedule;
  if (!plan) throw runtimeSpawnError("runtime_event_missing", `Fallback ${args.dispatchId} has no schedule data.`);
  const notBeforeMs = Date.parse(plan.notBeforeAt);
  const timer = setTimeout(
    () => {
      if (context.closed?.()) return;
      input.schedule(async () => {
        const currentRead = await readDispatchLifecycle(context, { by: "dispatch", dispatchIds: [args.dispatchId] });
        if (currentRead.status !== "ready")
          throw runtimeSpawnError("dispatch_lifecycle_pending", "Fallback lifecycle is not ready.");
        const currentGroup = currentRead.rows[0];
        if (!currentGroup?.policy.fallbackPending || currentGroup.controlLeafDispatchId !== args.dispatchId) return;
        const terminal = readDispatchStream(input.rootDir, args.dispatchId)?.terminalOutcome;
        if (terminal && (await publishTerminal(terminal))) return;
        if (Date.parse(input.now()) < notBeforeMs) return scheduleFallbackContinuation(args);
        const dispatchCwd = header.cwd!,
          fallback = header.fallbackAttempt!,
          nextAttemptIndex = fallback.attemptIndex + 1,
          naturalNextIndex = (fallback.candidateIndex ?? fallback.attemptIndex) + 1,
          exhaustedPass = naturalNextIndex >= fallback.candidates.length,
          nextCandidateIndex = fallback.candidates.findIndex(
            (candidate) =>
              candidate.instance === plan.nextProvider.instance && candidate.model === plan.nextProvider.model,
          ),
          next = fallback.candidates[nextCandidateIndex];
        if (!next)
          throw runtimeSpawnError(
            "runtime_event_missing",
            "Accepted fallback candidate is missing from the launch inputs.",
          );
        const nextFallback = {
            ...fallback,
            attemptIndex: nextAttemptIndex,
            candidateIndex: nextCandidateIndex,
            retryRound: (fallback.retryRound ?? 0) + (exhaustedPass ? 1 : 0),
            ...(fallback.waitStartedAt || plan.waitStartedAt || exhaustedPass
              ? { waitStartedAt: fallback.waitStartedAt ?? plan.waitStartedAt ?? input.now() }
              : {}),
          },
          continuation = continuationMission(stream.attemptOutcome!, fallback.originalMission);
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
        } catch (error) {
          consumeKnownError(error);
          const reason = String(
              scrubProviderValue(`Provider fallback could not launch ${next.instance}: ${runtimeErrorMessage(error)}`),
            ).slice(0, 1024),
            after = await readDispatchLifecycle(context, { by: "dispatch", dispatchIds: [header.dispatchId] });
          if (after.status !== "ready")
            throw runtimeSpawnError("dispatch_lifecycle_pending", "Fallback lifecycle is not ready.");
          // Once admission creates the successor, that leaf's own settlement owns the group.
          if (!after.rows[0]?.policy.fallbackPending || after.rows[0].controlLeafDispatchId !== header.dispatchId)
            return;
          const terminal = stream.terminalOutcome;
          if (!terminal?.payload.attempt)
            throw runtimeSpawnError("runtime_event_missing", "Fallback terminal publication is missing.");
          const { fallbackSchedule: _schedule, ...attempt } = terminal.payload.attempt;
          const exhausted = {
            ...terminal,
            reason,
            payload: { ...terminal.payload, attempt: { ...attempt, reason, fallbackState: "exhausted" as const } },
          };
          writer.appendTerminalOutcome(exhausted, input.now());
          await publishTerminal(exhausted);
        }
      }, runtimeBindingForDispatch(stream.header.binding!));
    },
    Math.min(Math.max(0, notBeforeMs - Date.parse(input.now())), 2_147_483_647),
  );
  timer.unref();
}

/** Group resources stay available across every attempt, including delayed/restarted continuations. */
export async function releaseFallbackResources(
  context: RuntimeSpawnerContext,
  lifecycle: DispatchLifecycleView,
  role?: string | null,
  cwd?: string | null,
): Promise<void> {
  if (!lifecycle.policy.groupSettled) return;
  if (role === "reviewer" && cwd) {
    const failure = await reclaimReviewWorktree(context.input.rootDir, cwd);
    if (failure)
      console.error(`[review-worktree] ${lifecycle.controlLeafDispatchId} could not be reclaimed: ${failure.message}`);
  }
  for (const dispatchId of lifecycle.groupDispatchIds) archiveDispatchStream(context.input.rootDir, dispatchId);
}
