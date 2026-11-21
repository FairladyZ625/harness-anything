import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { executionRuntimeBudgetPolicy } from "@harness-anything/kernel/internal/domain/task-submission-policy.ts";
import {
  collectRuntimeWorkspaceProgress,
  runtimeProgressSnapshot,
  type RuntimeWorkspaceProgress,
} from "./runtime-continuation-context.ts";
import { exponentialBackoffMs } from "./daemon-retry.ts";
import { canResumeSameSessionFault, effectiveProviderFault } from "./runtime-provider-fault.ts";
import { runtimeUnsettledTurnContinuation } from "../runtime-engine/runtime-inventory.ts";
import { runtimeExecutionBudgetRefusal } from "./runtime-spend-cap.ts";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel/internal/domain/settings.ts";
import {
  archiveDispatchStreams,
  readDispatchStream,
  removeDispatchStream,
  reopenDispatchStream,
  scrubProviderValue,
  type DispatchStreamHeader,
  type DispatchStreamWriter,
  type DispatchTerminalOutcome,
  type TrustedManagedCwdKind,
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
import { createHash, randomUUID } from "node:crypto";
import {
  consumeKnownError,
  isExhaustedDispatchTerminal,
  scheduledFallbackNotBefore,
  sha256Text,
  type AgentRuntimeEventV1,
  type DispatchLifecycleView,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { readDispatchLifecycle } from "./runtime-dispatch-admission.ts";
import { providerFallbackDispatchKey } from "./review-dispatch-key.ts";
import { runtimeErrorCode, runtimeErrorMessage, runtimeSpawnError } from "../runtime-engine/runtime-spawn-errors.ts";
import type { RuntimeAgent, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";
import { resolveRuntimeInstanceCandidates } from "./runtime-spawn-mission.ts";
import { reclaimReviewWorktree, resolveManagedReviewWorktreePath, type TaskWorktreeCheckout } from "./task-worktree.ts";
import {
  agentRuntimeModelMatches,
  agentRuntimeModelSpelling,
  agentRuntimeTargetForKind,
  agentRuntimeKindMatches,
} from "./agent-runtime-contract.ts";
import type { RuntimeInstanceKind, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
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
  selectionHints?: {
    readonly preferredInstanceId?: string;
    readonly preferredModel?: string;
    readonly avoidVendor?: string;
  },
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
            preferredInstanceId: selectionHints?.preferredInstanceId,
            avoidVendor: selectionHints?.avoidVendor,
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
    chainModel ??
    (selectionHints?.preferredInstanceId === instance.instanceId &&
    selectionHints.preferredModel !== undefined &&
    agentRuntimeModelMatches(instance.models, selectionHints.preferredModel)
      ? (agentRuntimeModelSpelling(instance.models, selectionHints.preferredModel) ?? selectionHints.preferredModel)
      : undefined) ??
    agentRuntimeTargetForKind(agent?.runtimes ?? [], instance.kindId)?.model ??
    instance.defaultModel;
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
      preferredInstanceId: selectionHints?.preferredInstanceId,
      avoidVendor: selectionHints?.avoidVendor,
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
export function sameSessionFaultContinuationPrompt(
  outcome: RuntimeAttemptOutcome,
  continuationPrompt: string = runtimeUnsettledTurnContinuation.prompt,
): string {
  return [
    "# Same-session transient fault continuation",
    `Previous attempt ended with a transient provider fault (${outcome.classification}: ${outcome.reason}).`,
    continuationPrompt,
  ].join("\n");
}

export function continuationMission(
  outcome: RuntimeAttemptOutcome,
  originalMission: string,
  workspace?: RuntimeWorkspaceProgress,
  node = "implementation",
): string {
  return [
    "# Provider fallback continuation",
    runtimeProgressSnapshot({ workspace, node, classification: outcome.classification, reason: outcome.reason }),
    "worktree 现状保留在原 cwd；继续同一任务，不使用 provider resume。",
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
> & {
  readonly budgetRefusal?: { readonly code: string; readonly message: string };
  readonly exhaustedReason?: string;
};

type FallbackSettlementSubject = Pick<
  ActiveRuntime,
  | "runtimeSessionId"
  | "stream"
  | "fallbackAttempt"
  | "providerFault"
  | "providerOutcome"
  | "startedAt"
  | "task"
  | "role"
  | "toolCallObserved"
  | "providerSessionId"
  | "resumeProviderSessionId"
  | "lossReason"
  | "errorOverflowed"
  | "errorBuffer"
  | "kindId"
  | "inputTokens"
  | "outputTokens"
>;

export async function settleFallbackAttempt(
  context: RuntimeSpawnerContext,
  active: FallbackSettlementSubject,
  outcome: RuntimeAttemptOutcome,
  terminal: RuntimeAttemptTerminal,
  singlePass?: boolean,
): Promise<FallbackSettlement | void> {
  const { input } = context;
  const exhaustedTerminal = async (
    reason: string,
    budgetRefusal?: { readonly code: string; readonly message: string },
  ): Promise<FallbackSettlement> => {
    active.stream.appendFallbackState({ state: "exhausted", reason }, input.now());
    await input.onAttemptTerminal?.({ ...terminal, outcome: "failed", reason });
    return { fallbackState: "exhausted", exhaustedReason: reason, ...(budgetRefusal ? { budgetRefusal } : {}) };
  };
  const scheduledTerminal = (
    schedule: NonNullable<FallbackSettlement["fallbackSchedule"]>,
    delayMs: number,
    sameSession?: { readonly sameSessionResume: true; readonly providerSessionId: string },
  ): FallbackSettlement => {
    active.stream.appendFallbackState(
      {
        state: "scheduled",
        ...schedule,
        delayMs,
        ...(sameSession ?? {}),
      },
      input.now(),
    );
    return { fallbackState: "scheduled", fallbackSchedule: schedule };
  };
  const fallback = active.fallbackAttempt;
  // A delivered attempt is not a provider failure, whatever its tail looked like: an accepted
  // submission or registered review is work the provider did complete, so it keeps the success
  // disposition it had before that tail was labelled (a drained reconnect is evidence about the
  // ending, not a reason to re-run a delivery).
  const delivered = terminal.outcome === "succeeded";
  const recordProviderFailure = (): void => {
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
  };
  if (delivered || !isProviderFailureClassification(outcome.classification) || !fallback) {
    if (isProviderFailureClassification(outcome.classification) && !delivered) recordProviderFailure();
    else if (active.providerOutcome === "succeeded" || delivered)
      input.runtimeProviderHealth?.recordSuccess(outcome.provider.instance, active.startedAt);
    await input.onAttemptTerminal?.(terminal);
    return;
  }
  if (active.task && !input.remote) {
    const limit = input.readSettings?.()?.runtime.executionUsageLimit ?? 0,
      refusal = runtimeExecutionBudgetRefusal(
        context.requiredRuntimeProjection(input),
        { ...active.task, role: active.role },
        limit > 0
          ? { ...executionRuntimeBudgetPolicy.defaultValue, maxTokens: limit }
          : executionRuntimeBudgetPolicy.defaultValue,
        active,
      );
    if (refusal) {
      recordProviderFailure();
      return exhaustedTerminal(`${refusal.code}: ${refusal.message}`, refusal);
    }
  }
  const currentCandidateIndex = fallback.candidateIndex ?? fallback.attemptIndex,
    nextAttemptIndex = fallback.attemptIndex + 1,
    runtimeSettings = input.readSettings?.()?.runtime,
    observedAt = Date.parse(input.now()),
    sameSessionRetryCount = fallback.sameSessionRetryCount ?? 0,
    postToolExecution = active.toolCallObserved || sameSessionRetryCount > 0;
  if (postToolExecution) {
    const sameSessionProviderSessionId =
        active.providerSessionId ?? fallback.sameSessionProviderSessionId ?? active.resumeProviderSessionId ?? null,
      providerFault = effectiveProviderFault(active),
      canResume =
        sameSessionProviderSessionId !== null &&
        canResumeSameSessionFault(
          {
            kindId: outcome.provider.kind,
            providerSessionId: sameSessionProviderSessionId,
            toolCallObserved: true,
            lossReason: active.lossReason ?? null,
          },
          providerFault === null && active.lossReason === null && outcome.classification === "provider_fault"
            ? null
            : 1,
          providerFault,
        );
    if (!canResume) {
      recordProviderFailure();
      return exhaustedTerminal(
        `Post-tool provider failure cannot safely resume on the same session: ${outcome.reason}`,
      );
    }
    const { sameSessionFaultMaxRetries, sameSessionFaultBackoffBaseMs, sameSessionFaultBackoffMaxMs } =
      daemonRuntimePolicy.defaultValue.runtime;
    if (sameSessionRetryCount >= sameSessionFaultMaxRetries) {
      recordProviderFailure();
      return exhaustedTerminal(
        `Same-session resume exhausted after ${String(sameSessionRetryCount)} retry(s) (${String(nextAttemptIndex)} attempt(s)): ${outcome.reason}`,
      );
    }
    const delayMs = exponentialBackoffMs({
        attempt: sameSessionRetryCount,
        baseMs: sameSessionFaultBackoffBaseMs,
        maxMs: sameSessionFaultBackoffMaxMs,
      }),
      resetAt =
        outcome.classification === "provider_quota" && outcome.resetAt ? Date.parse(outcome.resetAt) : Number.NaN,
      notBeforeMs = Math.max(observedAt + delayMs, Number.isFinite(resetAt) ? resetAt : observedAt),
      waitStartedAt = fallback.waitStartedAt ? Date.parse(fallback.waitStartedAt) : observedAt,
      maxWaitMs = Math.max(
        0,
        Number(runtimeSettings?.providerMaxWaitSeconds ?? INITIAL_SETTINGS_V1.runtime.providerMaxWaitSeconds) * 1_000,
      );
    if (observedAt - waitStartedAt + Math.max(0, notBeforeMs - observedAt) > maxWaitMs) {
      recordProviderFailure();
      return exhaustedTerminal(
        `Same-session resume wait budget exhausted after ${String(Math.max(0, observedAt - waitStartedAt))}ms: ${outcome.reason}`,
      );
    }
    const nextProvider = fallback.candidates[currentCandidateIndex] ?? {
      instance: outcome.provider.instance,
      model: outcome.provider.model,
    };
    return scheduledTerminal(
      {
        notBeforeAt: new Date(notBeforeMs).toISOString(),
        nextProvider,
        waitStartedAt: new Date(waitStartedAt).toISOString(),
      },
      delayMs,
      { sameSessionResume: true, providerSessionId: sameSessionProviderSessionId },
    );
  }
  recordProviderFailure();
  const nextCandidateIndex = currentCandidateIndex + 1,
    retryRound = fallback.retryRound ?? 0,
    maxRetries = Math.max(
      0,
      Number(runtimeSettings?.providerMaxRetries ?? INITIAL_SETTINGS_V1.runtime.providerMaxRetries),
    ),
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
  const roundCeiling = singlePass ? retryRound : maxRetries;
  if (exhausted && (retryRound >= roundCeiling || recoverAt === null))
    return exhaustedTerminal(
      `Provider fallback exhausted after ${String(nextAttemptIndex)} attempt(s) and ${String(retryRound)} retry round(s): ${outcome.reason}. ` +
        `Candidates: ${fallbackAvailabilitySummary(fallback.candidates, input.runtimeProviderHealth)}`,
    );
  const next = fallback.candidates[exhausted ? 0 : selection!.index]!,
    roundBaseMs = Math.max(
      0,
      Number(
        runtimeSettings?.providerRoundBackoffBaseSeconds ?? INITIAL_SETTINGS_V1.runtime.providerRoundBackoffBaseSeconds,
      ) * 1_000,
    ),
    roundMaxMs = Math.max(
      roundBaseMs,
      Number(
        runtimeSettings?.providerRoundBackoffMaxSeconds ?? INITIAL_SETTINGS_V1.runtime.providerRoundBackoffMaxSeconds,
      ) * 1_000,
    ),
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
    maxWaitMs = Math.max(
      0,
      Number(runtimeSettings?.providerMaxWaitSeconds ?? INITIAL_SETTINGS_V1.runtime.providerMaxWaitSeconds) * 1_000,
    );
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

type RuntimeOutcome = Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>["payload"];

function exhaustFallback(attempt: NonNullable<RuntimeOutcome["attempt"]>, reason = attempt.reason) {
  const { fallbackSchedule: _schedule, ...settled } = attempt;
  return { ...settled, reason, fallbackState: "exhausted" as const };
}

/** Cancellation may have no spool. Reuse the accepted terminal claims from the repository cut. */
export function readFallbackExhaustion(
  projection: Pick<TaskProjectionQueries, "readRuntimeSession" | "readRuntimeSessionEventsByType">,
  readResult: (ref: string) => string,
  { runtimeSessionId, dispatchId, outcome }: DispatchLifecycleView["attempt"],
): Pick<DispatchTerminalOutcome, "payload" | "body"> {
  const terminal = projection
    .readRuntimeSessionEventsByType(runtimeSessionId, ["runtime_session_outcome_observed"])
    .findLast(
      (event): event is Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }> =>
        event.type === "runtime_session_outcome_observed" &&
        event.payload.dispatchId === dispatchId &&
        event.payload.outcome === outcome,
    );
  if (!terminal?.payload.attempt)
    throw runtimeSpawnError("runtime_event_missing", "Pending fallback terminal publication is missing.");
  const session = projection.readRuntimeSession(runtimeSessionId),
    { reasonCode: _observedReasonCode, ...observed } = terminal.payload,
    resultRef = session?.resultRef ?? observed.resultRef,
    reasonCode = session?.outcome != null ? session.reasonCode : terminal.payload.reasonCode;
  const payload = {
    ...observed,
    resultRef,
    ...(session?.outcome != null ? { outcome: session.outcome, exitCode: session.exitCode } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    attempt: exhaustFallback(terminal.payload.attempt),
  };
  return { payload, body: readResult(resultRef) };
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
    workspaceProgress: RuntimeWorkspaceProgress,
    inheritedCwd?: string,
    preparedWorktree?: TaskWorktreeCheckout | null,
    trustedManagedCwd?: TrustedManagedCwdKind,
  ) => Promise<unknown>;
  readonly ensureFallbackWorktree?: (input: {
    readonly role?: string;
    readonly taskId: string | null;
    readonly executionId: string | null;
    readonly reviewTarget?: DispatchStreamHeader["reviewTarget"];
    readonly cwd: string;
    readonly dispatchKey: string;
    readonly trustedManagedCwd?: TrustedManagedCwdKind;
  }) => Promise<TaskWorktreeCheckout | null>;
  readonly dispatchId: string;
}): Promise<void> {
  const { context } = args,
    { input } = context;
  if (context.closed?.() || context.closeSignal?.aborted) return;
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
      outcome:
        terminal.payload.reasonCode === "review_cut_superseded" || terminal.reason.startsWith("review_cut_superseded:")
          ? "superseded"
          : "failed",
      reason: terminal.reason,
      endedAt: terminal.payload.endedAt ?? input.now(),
      binding,
    });
    await releaseFallbackResources(context, settled.rows[0], header.role, header.cwd);
    return true;
  };
  // Replay durable exhaustion bytes first; only an exhausted terminal can close a waiting_backoff group.
  if (isExhaustedDispatchTerminal(stream.terminalOutcome) && (await publishTerminal(stream.terminalOutcome!))) return;
  const plan = lifecycle.successor.schedule;
  if (!plan) throw runtimeSpawnError("runtime_event_missing", `Fallback ${args.dispatchId} has no schedule data.`);
  const notBeforeMs = Date.parse(plan.notBeforeAt);
  const signal = context.closeSignal;
  if (signal?.aborted) return;
  let detachAbort: (() => void) | undefined;
  const timer = setTimeout(
    async () => {
      detachAbort?.();
      if (context.closed?.() || signal?.aborted) return;
      // Host probes finish before input.schedule enters the exclusive writer turn (D1).
      let ensuredWorktree: TaskWorktreeCheckout | null = null;
      let worktreeRestoreError: unknown = null;
      let probeCwd = header.cwd!;
      if (header.role === "reviewer" && header.taskId && args.ensureFallbackWorktree) {
        try {
          ensuredWorktree = await args.ensureFallbackWorktree({
            role: header.role,
            taskId: header.taskId,
            executionId: header.executionId,
            reviewTarget: header.reviewTarget,
            cwd: probeCwd,
            dispatchKey: header.fallbackAttempt!.rootDispatchKey,
            trustedManagedCwd: header.trustedManagedCwd,
          });
          if (ensuredWorktree) probeCwd = ensuredWorktree.cwd;
        } catch (error) {
          consumeKnownError(error);
          worktreeRestoreError = error;
        }
      }
      let workspaceProgress: RuntimeWorkspaceProgress = { head: null, changedFiles: null, unavailable: null };
      let remoteNode: string | null | undefined = null;
      try {
        workspaceProgress = await collectRuntimeWorkspaceProgress(probeCwd);
        remoteNode = header.taskId && input.remote ? await input.remote.readTaskLifecycleNode?.(header.taskId) : null;
      } catch (error) {
        consumeKnownError(error);
        workspaceProgress = {
          ...workspaceProgress,
          unavailable: `progress snapshot unavailable (${runtimeErrorCode(error) ?? "probe_failed"})`,
        };
      }
      if (context.closed?.() || signal?.aborted) return;
      input.schedule(async () => {
        if (context.closed?.() || signal?.aborted) return;
        const currentRead = await readDispatchLifecycle(context, { by: "dispatch", dispatchIds: [args.dispatchId] });
        if (currentRead.status !== "ready")
          throw runtimeSpawnError("dispatch_lifecycle_pending", "Fallback lifecycle is not ready.");
        const currentGroup = currentRead.rows[0];
        if (!currentGroup?.policy.fallbackPending || currentGroup.controlLeafDispatchId !== args.dispatchId) return;
        const currentStream = readDispatchStream(input.rootDir, args.dispatchId),
          terminal = currentStream?.terminalOutcome;
        if (isExhaustedDispatchTerminal(terminal) && (await publishTerminal(terminal!))) return;
        if (Date.parse(input.now()) < notBeforeMs) return scheduleFallbackContinuation(args);
        const dispatchCwd = header.cwd!,
          fallback = header.fallbackAttempt!,
          scheduledFallback = currentStream?.scheduledFallback ?? stream.scheduledFallback,
          sameSessionResume =
            scheduledFallback?.sameSessionResume === true && typeof scheduledFallback.providerSessionId === "string",
          sameSessionProviderSessionId = sameSessionResume ? scheduledFallback.providerSessionId! : undefined,
          nextAttemptIndex = fallback.attemptIndex + 1,
          currentCandidateIndex = fallback.candidateIndex ?? fallback.attemptIndex,
          naturalNextIndex = currentCandidateIndex + 1,
          exhaustedPass = !sameSessionResume && naturalNextIndex >= fallback.candidates.length,
          nextCandidateIndex = sameSessionResume
            ? currentCandidateIndex
            : fallback.candidates.findIndex(
                (candidate) =>
                  candidate.instance === plan.nextProvider.instance && candidate.model === plan.nextProvider.model,
              ),
          next = sameSessionResume
            ? (fallback.candidates[currentCandidateIndex] ?? plan.nextProvider)
            : fallback.candidates[nextCandidateIndex];
        if (!next)
          throw runtimeSpawnError(
            "runtime_event_missing",
            "Accepted fallback candidate is missing from the launch inputs.",
          );
        const nextFallback = {
            ...fallback,
            attemptIndex: nextAttemptIndex,
            candidateIndex: nextCandidateIndex,
            retryRound: sameSessionResume
              ? (fallback.retryRound ?? 0)
              : (fallback.retryRound ?? 0) + (exhaustedPass ? 1 : 0),
            ...(sameSessionResume
              ? {
                  sameSessionRetryCount: (fallback.sameSessionRetryCount ?? 0) + 1,
                  sameSessionProviderSessionId,
                }
              : {}),
            ...(fallback.waitStartedAt || plan.waitStartedAt || exhaustedPass
              ? { waitStartedAt: fallback.waitStartedAt ?? plan.waitStartedAt ?? input.now() }
              : {}),
          },
          continuation = sameSessionResume
            ? sameSessionFaultContinuationPrompt(stream.attemptOutcome!, runtimeUnsettledTurnContinuation.prompt)
            : continuationMission(
                stream.attemptOutcome!,
                fallback.originalMission,
                workspaceProgress,
                header.taskId && !input.remote
                  ? (context.requiredRuntimeProjection(input).read(header.taskId, false, false).snapshot.task
                      ?.currentNode ?? "implementation")
                  : (remoteNode ?? "unavailable"),
              );
        try {
          if (worktreeRestoreError !== null) throw worktreeRestoreError;
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
              ...(header.mcpPolicy ? { mcpPolicy: header.mcpPolicy } : {}),
              ...(sameSessionProviderSessionId ? { providerSessionId: sameSessionProviderSessionId } : {}),
              ...(header.reviewTarget ? { reviewTarget: header.reviewTarget } : {}),
              ...(header.role === "reviewer" && header.taskId && header.executionId
                ? { executionId: header.executionId }
                : {}),
              prompt: continuation,
              ...(header.promptSource ? { promptSource: header.promptSource } : {}),
              ...(header.onExitCommand ? { onExitCommand: header.onExitCommand } : {}),
              ...(header.taskId ? { taskId: header.taskId } : {}),
              dispatchKey: providerFallbackDispatchKey(fallback.rootDispatchKey, nextAttemptIndex),
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
            workspaceProgress,
            ensuredWorktree ? ensuredWorktree.cwd : dispatchCwd,
            ensuredWorktree,
            ensuredWorktree ? "worktree" : header.trustedManagedCwd,
          );
        } catch (error) {
          consumeKnownError(error);
          // Closing the local slot queue does not settle the accepted provider continuation.
          if (runtimeErrorCode(error) === "RUNTIME_CLOSING") return;
          const errorCode = runtimeErrorCode(error),
            superseded = errorCode === "review_cut_superseded",
            reason = String(
              scrubProviderValue(
                superseded
                  ? `review_cut_superseded: ${runtimeErrorMessage(error)}`
                  : `Provider fallback could not launch ${next.instance}: ${runtimeErrorMessage(error)}`,
              ),
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
          const exhausted = {
            ...terminal,
            reason,
            payload: {
              ...terminal.payload,
              ...(errorCode === "execution_budget_exceeded" && terminal.payload.reasonCode === undefined
                ? { reasonCode: "execution_budget_exceeded" }
                : {}),
              attempt: exhaustFallback(terminal.payload.attempt, reason),
            },
          };
          writer.appendTerminalOutcome(exhausted, input.now());
          await publishTerminal(exhausted);
        }
      }, runtimeBindingForDispatch(stream.header.binding!));
    },
    Math.min(Math.max(0, notBeforeMs - Date.parse(input.now())), 2_147_483_647),
  );
  timer.unref();
  if (signal) {
    const onAbort = (): void => clearTimeout(timer);
    signal.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => signal.removeEventListener("abort", onAbort);
  }
}

/** Settles an admitted attempt whose launcher proved no OS process was created, routing through fallback and group cleanup. */
export async function settleStartRejectedAttempt(args: {
  readonly context: RuntimeSpawnerContext;
  readonly stream: DispatchStreamWriter;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly kindId: RuntimeInstanceKind;
  readonly model: string;
  readonly role: string | null;
  readonly cwd: string;
  readonly startedAt: string;
  readonly task: ActiveRuntime["task"];
  readonly schedule: ActiveRuntime["schedule"];
  readonly binding: RuntimeBinding;
  readonly fallbackAttempt: RuntimeFallbackAttempt | null;
  readonly resumeProviderSessionId: string | null;
  readonly error: unknown;
}): Promise<{ readonly fallbackPending: boolean }> {
  const {
      context,
      stream,
      dispatchId,
      runtimeSessionId,
      instanceId,
      kindId,
      model,
      role,
      cwd,
      startedAt,
      task,
      schedule,
      binding,
      fallbackAttempt,
      resumeProviderSessionId,
      error,
    } = args,
    { input } = context,
    endedAt = input.now(),
    rawReason = String(scrubProviderValue(runtimeErrorMessage(error))).slice(0, 1024),
    errorCode = runtimeErrorCode(error),
    faultClassification: RuntimeAttemptOutcome["classification"] = "provider_fault",
    groupId = fallbackAttempt?.attemptGroupId ?? dispatchId,
    index = fallbackAttempt?.attemptIndex ?? 0,
    observed: RuntimeAttemptOutcome = {
      classification: faultClassification,
      reason: rawReason,
      provider: { instance: instanceId, model, kind: kindId },
      attemptGroupId: groupId,
      attemptIndex: index,
    };
  stream.appendAttemptOutcome(observed, endedAt);
  const subject: FallbackSettlementSubject = {
      runtimeSessionId,
      stream,
      fallbackAttempt,
      providerFault: null,
      providerOutcome: "failed",
      startedAt,
      task,
      role,
      toolCallObserved: false,
      providerSessionId: null,
      resumeProviderSessionId,
      lossReason: null,
      errorOverflowed: false,
      errorBuffer: "",
      kindId,
      inputTokens: 0,
      outputTokens: 0,
    },
    singlePass = Boolean(error),
    fallback = await settleFallbackAttempt(
      context,
      subject,
      observed,
      {
        runtimeSessionId,
        dispatchId,
        task: null,
        schedule,
        outcome: "failed",
        reason: rawReason,
        endedAt,
        binding,
      },
      singlePass,
    ),
    { budgetRefusal, exhaustedReason, ...fallbackDisposition } = fallback ?? { fallbackState: null },
    effectiveReason = budgetRefusal
      ? `${budgetRefusal.code}: ${budgetRefusal.message}`
      : (exhaustedReason ?? rawReason),
    body = `Runtime dispatch failed before provider registration: ${rawReason}`,
    sha256 = sha256Text(body),
    terminalOutcome: DispatchTerminalOutcome = {
      payload: {
        runtimeSessionId,
        dispatchId,
        outcome: "failed",
        exitCode: null,
        resultRef: `artifact:runtime-result/sha256/${sha256}`,
        result: { sha256, size: Buffer.byteLength(body), mediaType: context.resultMediaType },
        ...(budgetRefusal ? { reasonCode: budgetRefusal.code } : errorCode ? { reasonCode: errorCode } : {}),
        endedAt,
        attempt: {
          classification: observed.classification,
          reason: effectiveReason,
          ...fallbackDisposition,
        },
      },
      body,
      reason: effectiveReason,
    };
  stream.appendTerminalOutcome(terminalOutcome, endedAt);
  await context.publishRuntimeEvent("runtime_session_exited", { runtimeSessionId }, randomUUID(), binding);
  const outcomeEvent = await context.publishRuntimeEvent(
    "runtime_session_outcome_observed",
    terminalOutcome.payload,
    randomUUID(),
    binding,
    body,
  );
  if (outcomeEvent.event) input.onRuntimeOutcome?.(outcomeEvent.event, schedule);
  const read = await readDispatchLifecycle(context, { by: "dispatch", dispatchIds: [dispatchId] }),
    lifecycle = read.status === "ready" ? read.rows[0] : undefined;
  if (lifecycle?.policy.fallbackPending) {
    await context.reconcileFallback(dispatchId);
    return { fallbackPending: true };
  }
  if (lifecycle?.policy.groupSettled) {
    await releaseFallbackResources(context, lifecycle, role, cwd, lifecycle.groupDispatchIds.length > 1);
    if (lifecycle.groupDispatchIds.length <= 1) removeDispatchStream(input.rootDir, dispatchId);
    return { fallbackPending: false };
  }
  // Center lifecycle is pending or has not yet projected this dispatch. Preserve the node-local
  // dispatch stream and review checkout so reconcileFallback or restart adoption can finish recovery.
  const scheduledNotBefore = scheduledFallbackNotBefore(fallback ?? null, endedAt);
  if (scheduledNotBefore !== null) {
    if (!context.closed?.() && !context.closeSignal?.aborted) {
      const signal = context.closeSignal,
        delayMs = Math.min(Math.max(0, Date.parse(scheduledNotBefore) - Date.parse(input.now())), 2_147_483_647);
      let detachAbort: (() => void) | undefined;
      const timer = setTimeout(() => {
        detachAbort?.();
        if (context.closed?.() || signal?.aborted) return;
        input.schedule(async () => {
          await context.reconcileFallback(dispatchId);
        }, binding);
      }, delayMs);
      timer.unref();
      if (signal) {
        const onAbort = (): void => clearTimeout(timer);
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
    }
    return { fallbackPending: true };
  }
  return { fallbackPending: false };
}

/** Group resources stay available across every attempt, including delayed/restarted continuations. */
export async function releaseFallbackResources(
  context: RuntimeSpawnerContext,
  lifecycle: DispatchLifecycleView,
  role?: string | null,
  cwd?: string | null,
  archiveStreams = true,
): Promise<void> {
  if (!lifecycle.policy.groupSettled) return;
  if (role === "reviewer" && cwd) {
    const targetPath = resolveManagedReviewWorktreePath(context.input.rootDir, cwd);
    if (targetPath !== null) {
      const inUseBySibling =
        context.processes !== undefined &&
        [...context.processes.values()].some(
          (active) =>
            active.cwd === cwd ||
            active.cwd === targetPath ||
            resolveManagedReviewWorktreePath(context.input.rootDir, active.cwd) === targetPath,
        );
      if (!inUseBySibling) {
        const failure = await reclaimReviewWorktree(context.input.rootDir, targetPath);
        if (failure)
          console.error(
            `[review-worktree] ${lifecycle.controlLeafDispatchId} could not be reclaimed: ${failure.message}`,
          );
      }
    }
  }
  if (archiveStreams) archiveDispatchStreams(context.input.rootDir, lifecycle.groupDispatchIds);
}
