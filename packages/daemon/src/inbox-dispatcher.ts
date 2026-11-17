import path from "node:path";
import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  RUNTIME_INBOX_PAGE_LIMIT,
  evaluateRuntimeInboxBatch,
  isTerminalStatus,
  resolveSessionContinuationMode,
  type AgentRuntimeEventV1,
  type CanonicalEventStore,
  type DaemonRepoMode,
  type DispatchLifecycleQuery,
  type DispatchLifecycleView,
  type PriorTerminalDispositionKind,
  type RuntimeInboxGroup,
  type RuntimeInboxItem,
  type RuntimeInboxSettlementKind,
  type RuntimeSession,
  type TaskProjection,
  type TaskV2,
} from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { readDispatchStream } from "./dispatch-stream.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding, RepoCellOperationalContext, RepoTaskAction } from "./repo-cell-types.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "./runtime-spawn-errors.ts";
import type { makeRuntimeSpawner } from "./runtime-spawn.ts";
import type { makeSquadCoordinator } from "./squad-coordinator.ts";
import { terminal as squadTerminal } from "./squad-run-state.ts";
import { openTaskWorktreeBinding, presetSnapshotReader } from "./task-worktree.ts";

const INBOX_CLAIM_LEASE_MS = 60_000;

function inboxOpSlug(inboxId: string): string {
  return inboxId.replaceAll(/[^A-Za-z0-9._-]+/gu, "_");
}

function sanitizeOperatorBinding(binding: RepoCellBinding): RepoCellBinding {
  return {
    ...binding,
    executionPrincipal: undefined,
    delegatedExecutionToken: undefined,
    actor: { principal: binding.actor.principal, executor: null },
  };
}

export interface InboxDispatcher {
  wake(binding?: RepoCellBinding): void;
  drain(): Promise<void>;
  close(): void;
}

export interface InboxDispatcherDeps {
  readonly rootDir: string;
  readonly repoId: string;
  readonly mode: DaemonRepoMode;
  readonly now: () => string;
  readonly projection: TaskProjection;
  readonly store: CanonicalEventStore;
  readonly schedule: (work: () => void | Promise<void>, binding?: RepoCellBinding) => void;
  readonly appendAuxiliaryRuntimeIngress: RepoCellOperationalContext["appendAuxiliaryRuntimeIngress"];
  readonly runtimeSpawner: Pick<ReturnType<typeof makeRuntimeSpawner>, "prepareWorktree" | "spawn">;
  readonly squadCoordinator: Pick<ReturnType<typeof makeSquadCoordinator>, "start">;
  readonly authorizeRuntimeAction: (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    actionId: string,
  ) => Promise<RepoCellBinding>;
  readonly onlineBinding: (binding: RepoCellBinding) => Promise<RepoCellBinding>;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

type DispatchRequestedEvent = Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;
type InboxSettlementOutcome = {
  readonly settlement: RuntimeInboxSettlementKind;
  readonly dispatchId: string | null;
  readonly reason: string | null;
};

/**
 * Event-driven daemon dispatcher for canonical `Inbox` items (`dec_E0CB793DAA21F49FF1E98D5067`).
 * Wakes only on canonical/lifecycle events or a single computed coalesce/lease-expiry deadline.
 */
export function makeInboxDispatcher(deps: InboxDispatcherDeps): InboxDispatcher {
  const scheduleTimer =
      deps.setTimer ??
      ((callback: () => void, delayMs: number) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
      }),
    cancelTimer = deps.clearTimer ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  let closed = false,
    scheduled = false,
    draining = false,
    drainRequested = false,
    drainPromise: Promise<void> | null = null,
    timer: ReturnType<typeof setTimeout> | null = null,
    latestBinding: RepoCellBinding | undefined;

  const clearWakeTimer = () => {
    if (timer === null) return;
    cancelTimer(timer);
    timer = null;
  };

  const scheduleWakeTimer = (wakeAtIso: string) => {
    if (closed) return;
    const targetMs = Date.parse(wakeAtIso),
      nowMs = Date.parse(deps.now());
    if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) return;
    clearWakeTimer();
    const delayMs = Math.max(0, Math.trunc(targetMs - nowMs));
    timer = scheduleTimer(() => {
      timer = null;
      wake();
    }, delayMs);
  };

  const appendInboxEvent = async (
    type: "runtime_inbox_claimed" | "runtime_inbox_settled" | "runtime_session_resume_degraded",
    opId: string,
    payload: Readonly<Record<string, unknown>>,
    binding: RepoCellBinding,
  ): Promise<void> => {
    const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined,
      action: RepoTaskAction = {
        kind: "runtime-run",
        runtimeEventType: type,
        ...(taskId ? { taskId } : {}),
      },
      authorized = await deps.authorizeRuntimeAction(action, binding, `inbox:${opId}`);
    if (authorized.authorizationDecision?.outcome === "denied")
      throw cellCodedError(
        "authorization_denied",
        authorized.authorizationDecision.nextActions.join(" ") || `Inbox event ${type} requires repo-write authority.`,
      );
    deps.appendAuxiliaryRuntimeIngress({ kind: "event", type, opId, payload }, authorized, true);
  };

  const resolveBaseBinding = async (
    fallbackDispatch: DispatchRequestedEvent | null,
  ): Promise<RepoCellBinding | null> => {
    if (latestBinding) return deps.onlineBinding(latestBinding);
    if (fallbackDispatch)
      return deps.onlineBinding({
        actor: { principal: fallbackDispatch.actor.principal, executor: null },
        source: fallbackDispatch.source,
      } as unknown as RepoCellBinding);
    return null;
  };

  const processGroup = async (
    group: RuntimeInboxGroup,
    activeDispatches: readonly DispatchLifecycleView[],
  ): Promise<string | null> => {
    const candidates = openCandidatesForGroup(group, deps.now());
    if (candidates.length === 0) return null;

    const primary = candidates.at(-1)!,
      primaryDispatch = readDispatchEvent(deps.projection, candidates);
    if (shouldSkipForPlacement(deps.mode, deps.projection, candidates, primaryDispatch)) return null;

    const { hasRunningAttempt, priorStopProof } = inspectGroupExecutionState(
      deps.projection,
      candidates,
      activeDispatches,
    );
    if (priorStopProof === "pending") return null;

    const evaluation = evaluateRuntimeInboxBatch(group, {
      now: deps.now(),
      hasRunningAttempt,
      priorStopProof,
    });
    if (!evaluation.ready) return evaluation.wakeAt;

    const baseBinding = await resolveBaseBinding(primaryDispatch);
    if (!baseBinding || closed) return null;

    const claimFence = evaluation.nextClaimFence,
      claimedAt = deps.now(),
      leaseUntil = new Date(Date.parse(claimedAt) + INBOX_CLAIM_LEASE_MS).toISOString(),
      itemIds = evaluation.items.map((item) => item.itemId),
      claimOpId = `inbox-claim-${inboxOpSlug(group.inboxId)}-${String(claimFence)}`;

    const claimed = await appendInboxEvent(
      "runtime_inbox_claimed",
      claimOpId,
      {
        inboxId: group.inboxId,
        itemIds,
        claimFence,
        claimedByDispatchId: null,
        leaseUntil,
        claimedAt,
      },
      baseBinding,
    ).then(
      () => ({ applied: true as const }),
      (error: unknown) => ({ applied: false as const, error }),
    );
    if (!claimed.applied) {
      if (runtimeErrorCode(claimed.error) === "op_conflict") return null;
      throw claimed.error;
    }

    const settlement = await executeClaimedBatch(group, evaluation.items, claimFence, baseBinding, primary);
    if (closed) return null;

    const settleOpId = `inbox-settle-${inboxOpSlug(group.inboxId)}-${String(claimFence)}`;
    await appendInboxEvent(
      "runtime_inbox_settled",
      settleOpId,
      {
        inboxId: group.inboxId,
        itemIds,
        claimFence,
        settlement: settlement.settlement,
        settledByDispatchId: settlement.dispatchId,
        reason: settlement.reason,
        settledAt: deps.now(),
      },
      baseBinding,
    );
    return null;
  };

  const executeClaimedBatch = async (
    group: RuntimeInboxGroup,
    items: readonly RuntimeInboxItem[],
    claimFence: number,
    baseBinding: RepoCellBinding,
    primary: RuntimeInboxItem,
  ): Promise<InboxSettlementOutcome> => {
    try {
      const taskId = latestNonEmptyField(items, (item) => item.taskId) ?? primary.taskId;
      if (!taskId) return { settlement: "dead_letter", dispatchId: null, reason: "missing_task_id" };

      const taskRead = deps.projection.read(taskId),
        task = taskRead.snapshot.task;
      if (!task) return { settlement: "dead_letter", dispatchId: null, reason: "task_not_found" };
      if (isTerminalStatus(task.status))
        return { settlement: "consumed", dispatchId: null, reason: `task_already_terminal:${task.status}` };
      if (task.status === "blocked") return { settlement: "released", dispatchId: null, reason: "task_blocked" };

      const squadId = typeof primary.data.squadId === "string" ? primary.data.squadId : null;
      if (squadId) return await executeSquadResume(taskId, squadId, primary, baseBinding);

      return await executeDirectWorkerResume(group, items, claimFence, task, taskId, primary, baseBinding);
    } catch (error) {
      const code = runtimeErrorCode(error),
        message = runtimeErrorMessage(error);
      return {
        settlement: "dead_letter",
        dispatchId: null,
        reason: (code ? `${code}: ${message}` : message).slice(0, 240),
      };
    }
  };

  const executeSquadResume = async (
    taskId: string,
    squadId: string,
    item: RuntimeInboxItem,
    baseBinding: RepoCellBinding,
  ): Promise<InboxSettlementOutcome> => {
    const runtimeInstanceId =
      typeof item.data.runtimeInstanceId === "string" && item.data.runtimeInstanceId.length > 0
        ? item.data.runtimeInstanceId
        : null;
    if (!runtimeInstanceId)
      return { settlement: "dead_letter", dispatchId: null, reason: "missing_squad_runtime_instance" };

    const squadAction = { kind: "squad-run", taskId, squadId, runtimeInstanceId },
      authorized = await deps.authorizeRuntimeAction(
        squadAction,
        baseBinding,
        `inbox-squad-resume:${taskId}:${item.itemId}`,
      );
    if (authorized.authorizationDecision?.outcome === "denied")
      return { settlement: "dead_letter", dispatchId: null, reason: "authorization_denied" };

    const receipt = await deps.squadCoordinator.start({ taskId, squadId, runtimeInstanceId }, authorized);
    return {
      settlement: "consumed",
      dispatchId: typeof receipt.stateDispatchId === "string" ? receipt.stateDispatchId : null,
      reason: `squad_resumed:${String(receipt.squadRunId ?? squadId)}`,
    };
  };

  const emitResumeDegraded = async (
    params: {
      readonly opId: string;
      readonly runtimeSessionId: string;
      readonly dispatchId: string;
      readonly sourceDispatchId: string | null;
      readonly providerSessionId: string;
      readonly taskId: string | null;
      readonly agentId: string | null;
      readonly degradedTo: "fresh" | "handoff";
      readonly reasonCode: string;
      readonly reason: string;
    },
    binding: RepoCellBinding,
  ): Promise<void> => {
    await appendInboxEvent(
      "runtime_session_resume_degraded",
      params.opId,
      {
        runtimeSessionId: params.runtimeSessionId,
        dispatchId: params.dispatchId,
        sourceDispatchId: params.sourceDispatchId,
        providerSessionId: params.providerSessionId,
        taskId: params.taskId,
        agentId: params.agentId,
        degradedTo: params.degradedTo,
        reasonCode: params.reasonCode,
        reason: params.reason.slice(0, 500) || params.reasonCode,
        observedAt: deps.now(),
      },
      binding,
    );
  };

  const executeDirectWorkerResume = async (
    group: RuntimeInboxGroup,
    items: readonly RuntimeInboxItem[],
    claimFence: number,
    task: TaskV2,
    taskId: string,
    primary: RuntimeInboxItem,
    baseBinding: RepoCellBinding,
  ): Promise<InboxSettlementOutcome> => {
    const sourceDispatchId = primary.dispatchId ?? latestNonEmptyField(items, (item) => item.dispatchId),
      escalatedDispatch = sourceDispatchId
        ? (deps.projection.readRuntimeDispatchById(sourceDispatchId)?.event as DispatchRequestedEvent | undefined)
        : undefined,
      runtimeInstanceId =
        (typeof primary.data.runtimeInstanceId === "string" && primary.data.runtimeInstanceId.length > 0
          ? primary.data.runtimeInstanceId
          : null) ??
        escalatedDispatch?.payload.instanceId ??
        null;
    if (!runtimeInstanceId) return { settlement: "dead_letter", dispatchId: null, reason: "missing_runtime_instance" };

    const previousAgentId = escalatedDispatch?.payload.agentId ?? null,
      requestedAgentId = primary.agentId ?? previousAgentId,
      agentId = requestedAgentId,
      priorSession = escalatedDispatch
        ? deps.projection.readRuntimeSession(escalatedDispatch.payload.runtimeSessionId)
        : null,
      providerSessionId =
        priorSession?.providerSessionId ??
        (typeof primary.data.providerSessionId === "string" && primary.data.providerSessionId.length > 0
          ? primary.data.providerSessionId
          : null),
      runtimeSupportsResume = escalatedDispatch
        ? runtimeSupportsProviderResume(escalatedDispatch.payload.kindId)
        : Boolean(providerSessionId),
      previousTerminalKind = derivePriorTerminalKind(deps.projection, priorSession, escalatedDispatch, primary),
      decision = resolveSessionContinuationMode({
        requestedAgentId,
        previousAgentId,
        taskId,
        previousTaskId: escalatedDispatch?.payload.taskId ?? taskId,
        lineageMatches: (escalatedDispatch?.payload.taskId ?? taskId) === taskId,
        providerSessionId,
        runtimeSupportsResume,
        previousTerminalKind,
        hasHandoffPacket: Boolean(primary.data.handoffPacket),
      });

    if (decision.blockedWithoutHandoff) {
      if (providerSessionId && escalatedDispatch)
        await emitResumeDegraded(
          {
            opId: `inbox-resume-degraded-${inboxOpSlug(group.inboxId)}-${String(claimFence)}`,
            runtimeSessionId: escalatedDispatch.payload.runtimeSessionId,
            dispatchId: sourceDispatchId ?? escalatedDispatch.payload.dispatchId,
            sourceDispatchId,
            providerSessionId,
            taskId,
            agentId,
            degradedTo: "handoff",
            reasonCode: decision.reason,
            reason: `Blocked cross-employee resume (${previousAgentId ?? "unknown"} -> ${requestedAgentId ?? "unknown"}) without HandoffPacketV1.`,
          },
          baseBinding,
        );
      return { settlement: "dead_letter", dispatchId: null, reason: decision.reason };
    }

    const priorStream = sourceDispatchId ? readDispatchStream(deps.rootDir, sourceDispatchId) : null,
      priorCwd = priorStream?.header.cwd ?? escalatedDispatch?.payload.cwd,
      managedBinding = openTaskWorktreeBinding(task, presetSnapshotReader(deps.projection)),
      matchesManagedWorktree =
        managedBinding !== null &&
        priorCwd !== undefined &&
        path.resolve(deps.rootDir, managedBinding.path) === path.resolve(priorCwd),
      cwdOption =
        priorCwd !== undefined
          ? matchesManagedWorktree
            ? undefined
            : deriveCwdOption(deps.rootDir, priorCwd)
          : managedBinding
            ? undefined
            : { scope: "repo-root" as const },
      baseDispatchKey = `inbox:${group.inboxId}:${String(claimFence)}`,
      prompt = `Continue task ${taskId}: ${items.map((item) => item.summary).join(" | ")}`,
      basePayload: JsonObject = {
        runtimeInstanceId,
        taskId,
        ...(agentId ? { agentId } : {}),
        ...(cwdOption ? { cwd: cwdOption } : {}),
        prompt,
        dispatchKey: baseDispatchKey,
      };

    const worktree = await deps.runtimeSpawner.prepareWorktree(basePayload),
      authorizeSpawn = async (payload: JsonObject, suffix: string) => {
        const authorized = await deps.authorizeRuntimeAction(
          {
            kind: "runtime-spawn",
            ...payload,
            executionRuntimeIngress: { kind: "runtime-run", ...payload },
          },
          baseBinding,
          `inbox-spawn:${group.inboxId}:${String(claimFence)}:${suffix}`,
        );
        if (authorized.authorizationDecision?.outcome === "denied")
          throw cellCodedError(
            "authorization_denied",
            authorized.authorizationDecision.nextActions.join(" ") ||
              "Inbox automatic dispatch requires repo-write authority.",
          );
        return authorized;
      };

    if (decision.mode === "continue" && decision.allowProviderResume && providerSessionId) {
      const resumePayload: JsonObject = {
        ...basePayload,
        providerSessionId,
        dispatchKey: `${baseDispatchKey}:resume`,
      };
      const authorizedResume = await authorizeSpawn(resumePayload, "resume"),
        resumedAttempt = await deps.runtimeSpawner.spawn(resumePayload, authorizedResume, worktree).then(
          (receipt) => ({ spawned: true as const, receipt }),
          (error: unknown) => ({ spawned: false as const, error }),
        );
      if (resumedAttempt.spawned)
        return {
          settlement: "consumed",
          dispatchId: typeof resumedAttempt.receipt.dispatchId === "string" ? resumedAttempt.receipt.dispatchId : null,
          reason: "resumed_provider_session",
        };
      if (closed || runtimeErrorCode(resumedAttempt.error) === "authorization_denied") throw resumedAttempt.error;
      await emitResumeDegraded(
        {
          opId: `inbox-resume-degraded-${inboxOpSlug(group.inboxId)}-${String(claimFence)}`,
          runtimeSessionId:
            priorSession?.runtimeSessionId ?? escalatedDispatch?.payload.runtimeSessionId ?? `inbox-${claimFence}`,
          dispatchId: sourceDispatchId ?? `inbox-${claimFence}`,
          sourceDispatchId,
          providerSessionId,
          taskId,
          agentId,
          degradedTo: "fresh",
          reasonCode: runtimeErrorCode(resumedAttempt.error) ?? "resume_failed",
          reason: runtimeErrorMessage(resumedAttempt.error),
        },
        baseBinding,
      );
    } else if (decision.mode === "fresh" && providerSessionId) {
      await emitResumeDegraded(
        {
          opId: `inbox-resume-degraded-${inboxOpSlug(group.inboxId)}-${String(claimFence)}`,
          runtimeSessionId:
            priorSession?.runtimeSessionId ?? escalatedDispatch?.payload.runtimeSessionId ?? `inbox-${claimFence}`,
          dispatchId: sourceDispatchId ?? `inbox-${claimFence}`,
          sourceDispatchId,
          providerSessionId,
          taskId,
          agentId,
          degradedTo: "fresh",
          reasonCode: decision.reason,
          reason: `Continuation fence selected fresh cold-start (${decision.reason}) instead of provider session ${providerSessionId}.`,
        },
        baseBinding,
      );
    }

    const freshPayload: JsonObject = {
        ...basePayload,
        dispatchKey: `${baseDispatchKey}:fresh`,
      },
      authorizedFresh = await authorizeSpawn(freshPayload, "fresh"),
      receipt = await deps.runtimeSpawner.spawn(freshPayload, authorizedFresh, worktree);
    return {
      settlement: "consumed",
      dispatchId: typeof receipt.dispatchId === "string" ? receipt.dispatchId : null,
      reason: "dispatched_fresh",
    };
  };

  const drainOnce = async (): Promise<void> => {
    clearWakeTimer();
    const groups: RuntimeInboxGroup[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = deps.projection.readRuntimeInbox({
        by: "open",
        limit: RUNTIME_INBOX_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (page.status !== "ready") return;
      groups.push(...page.rows);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    if (groups.length === 0) return;

    const activeDispatches: DispatchLifecycleView[] = [];
    for (let cursor: string | undefined; ; ) {
      const query: DispatchLifecycleQuery = {
          by: "active",
          limit: DISPATCH_LIFECYCLE_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        },
        page = deps.projection.readDispatchLifecycle(query);
      if (page.status !== "ready") return;
      activeDispatches.push(...page.rows);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    let earliestWakeAt: string | null = null;
    for (const group of groups) {
      if (closed) return;
      const wakeAt = await processGroup(group, activeDispatches);
      if (wakeAt !== null && (earliestWakeAt === null || Date.parse(wakeAt) < Date.parse(earliestWakeAt)))
        earliestWakeAt = wakeAt;
    }
    if (earliestWakeAt !== null && !closed) scheduleWakeTimer(earliestWakeAt);
  };

  const runDrainLoop = async (): Promise<void> => {
    draining = true;
    try {
      while (!closed && drainRequested) {
        drainRequested = false;
        await drainOnce();
      }
    } finally {
      draining = false;
    }
  };

  const ensureDrain = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (!drainPromise) {
      const active = runDrainLoop().finally(() => {
        if (drainPromise === active) drainPromise = null;
        if (!closed && drainRequested) wake();
      });
      drainPromise = active;
    }
    return drainPromise;
  };

  const wake = (binding?: RepoCellBinding): void => {
    if (closed) return;
    if (binding) latestBinding = sanitizeOperatorBinding(binding);
    drainRequested = true;
    if (scheduled || draining || drainPromise !== null) return;
    scheduled = true;
    deps.schedule(() => {
      scheduled = false;
      if (closed) return;
      return ensureDrain().catch((error: unknown) => {
        console.error("[inbox-dispatcher]", error);
      });
    }, latestBinding);
  };

  const drain = async (): Promise<void> => {
    if (closed) return;
    drainRequested = true;
    await ensureDrain();
  };

  const close = (): void => {
    closed = true;
    drainRequested = false;
    clearWakeTimer();
  };

  return { wake, drain, close };
}

function openCandidatesForGroup(group: RuntimeInboxGroup, nowIso: string): readonly RuntimeInboxItem[] {
  const nowMs = Date.parse(nowIso),
    activeClaim = group.activeClaim;
  if (activeClaim !== null && Date.parse(activeClaim.leaseUntil) > nowMs) return [];
  const expiredLease = activeClaim !== null && Date.parse(activeClaim.leaseUntil) <= nowMs;
  return group.items.filter((item) => item.status === "pending" || (expiredLease && item.status === "leased"));
}

function readDispatchEvent(
  projection: TaskProjection,
  items: readonly RuntimeInboxItem[],
): DispatchRequestedEvent | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const dispatchId = items[index]!.dispatchId;
    if (!dispatchId) continue;
    const row = projection.readRuntimeDispatchById(dispatchId)?.event;
    if (row?.type === "runtime_dispatch_requested") return row;
  }
  return null;
}

function shouldSkipForPlacement(
  mode: DaemonRepoMode,
  projection: TaskProjection,
  items: readonly RuntimeInboxItem[],
  primaryDispatch: DispatchRequestedEvent | null,
): boolean {
  if (mode === "remote-center") return true;
  if (primaryDispatch && primaryDispatch.source !== "local" && mode !== "remote-edge") return true;
  const taskId = latestNonEmptyField(items, (item) => item.taskId);
  if (!taskId || mode === "remote-edge") return false;
  const activeExecutionId = projection
    .read(taskId, false, false)
    .snapshot.executions.find((e) => e.state === "active")?.executionId;
  if (!activeExecutionId) return false;
  const interval = projection.readLatestLeaseIntervalForExecution(taskId, activeExecutionId);
  return interval !== null && interval.holder.source !== "local";
}

function inspectGroupExecutionState(
  projection: TaskProjection,
  candidates: readonly RuntimeInboxItem[],
  activeDispatches: readonly DispatchLifecycleView[],
): {
  readonly hasRunningAttempt: boolean;
  readonly priorStopProof: "proven_stopped" | "unproven" | "none" | "pending";
} {
  const taskIds = new Set(candidates.map((item) => item.taskId).filter((value): value is string => value !== null)),
    hasRunningTaskDispatch =
      taskIds.size > 0 &&
      activeDispatches.some(
        (row) =>
          row.attempt.task !== null &&
          taskIds.has(row.attempt.task.taskId) &&
          !row.policy.attemptSettled &&
          row.attempt.stopProof !== "proven_stopped",
      ),
    hasActiveSquadRun =
      taskIds.size > 0 &&
      projection.readSquadRuns().some(({ state }) => {
        const candidate = state as {
          readonly phase?: unknown;
          readonly subject?: { readonly kind?: unknown; readonly taskId?: unknown };
        };
        return (
          candidate.subject?.kind === "task" &&
          typeof candidate.subject.taskId === "string" &&
          taskIds.has(candidate.subject.taskId) &&
          typeof candidate.phase === "string" &&
          !squadTerminal({ phase: candidate.phase } as Parameters<typeof squadTerminal>[0])
        );
      }),
    hasRunningAttempt = hasRunningTaskDispatch || hasActiveSquadRun;

  const referencedDispatchIds = [
    ...new Set(candidates.map((item) => item.dispatchId).filter((value): value is string => value !== null)),
  ];
  if (referencedDispatchIds.length === 0) return { hasRunningAttempt, priorStopProof: "none" };

  for (let offset = 0; offset < referencedDispatchIds.length; offset += DISPATCH_LIFECYCLE_PAGE_LIMIT) {
    const read = projection.readDispatchLifecycle({
      by: "dispatch",
      dispatchIds: referencedDispatchIds.slice(offset, offset + DISPATCH_LIFECYCLE_PAGE_LIMIT),
    });
    if (read.status !== "ready") return { hasRunningAttempt, priorStopProof: "pending" };
    if (read.rows.some((row) => row.attempt.stopProof !== "proven_stopped"))
      return { hasRunningAttempt, priorStopProof: "unproven" };
  }
  return { hasRunningAttempt, priorStopProof: "proven_stopped" };
}

function runtimeSupportsProviderResume(kindId: string): boolean {
  const declaration = runtimeKindForId(kindId);
  return declaration.capabilities.resume === "supported" || declaration.declaredCapabilities.includes("resume");
}

function derivePriorTerminalKind(
  projection: TaskProjection,
  session: RuntimeSession | null,
  dispatch: DispatchRequestedEvent | undefined,
  primary: RuntimeInboxItem,
): PriorTerminalDispositionKind {
  if (session?.providerUnreachable) return "unreachable";
  const outcomes = dispatch
    ? projection.readRuntimeSessionEventsByType(dispatch.payload.runtimeSessionId, ["runtime_session_outcome_observed"])
    : [];
  const stalled = outcomes.some(
    (event) =>
      event.type === "runtime_session_outcome_observed" && event.payload.attempt?.classification === "dispatch_stalled",
  );
  if (stalled) return "stalled";
  const hasRulingOutcome = outcomes.some(
    (event) =>
      event.type === "runtime_session_outcome_observed" &&
      (event.payload.reasonCode === "ruling_resolved" || event.payload.attempt?.classification === "awaiting_ruling"),
  );
  // Worker escalation (`ha task escalate`) stops its own session via `escalation: true`, which sets
  // `cancelledBy` while preserving `outcome === "stopped"` and a ruling outcome. Keep `cancelled`
  // strictly for genuine cancellations without a ruling.
  if (
    session?.outcome === "cancelled" ||
    (session?.cancelledBy !== null &&
      session?.cancelledBy !== undefined &&
      !hasRulingOutcome &&
      primary.source !== "ruling_resolved")
  )
    return "cancelled";
  if (hasRulingOutcome || primary.source === "ruling_resolved") return "awaiting_ruling";
  if (session?.outcome === "succeeded") return "succeeded";
  if (session?.outcome === "failed") return "failed";
  return "none";
}

function deriveCwdOption(
  rootDir: string,
  dispatchCwd: string | undefined,
): { readonly scope: "repo-root" } | { readonly scope: "repo-relative"; readonly path: string } {
  if (!dispatchCwd) return { scope: "repo-root" };
  if (path.resolve(dispatchCwd) === path.resolve(rootDir)) return { scope: "repo-root" };
  const relative = path.relative(rootDir, dispatchCwd);
  if (relative === "" || relative === ".") return { scope: "repo-root" };
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { scope: "repo-root" };
  return { scope: "repo-relative", path: relative.replaceAll("\\", "/") };
}

function latestNonEmptyField<T extends string>(
  items: readonly RuntimeInboxItem[],
  pick: (item: RuntimeInboxItem) => T | null,
): T | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const value = pick(items[index]!);
    if (value !== null) return value;
  }
  return null;
}
