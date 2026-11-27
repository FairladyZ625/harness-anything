import { randomUUID } from "node:crypto";
import {
  canonicalEventWritePlan,
  sha256Text,
  type CanonicalContentBlob,
  type CanonicalEventStore,
  type RuntimeSteerMode,
  type TaskProjection,
} from "@harness-anything/kernel";
import {
  compileInboxClaimedEvent,
  compileInboxCompletedEvent,
  compileInboxDroppedStaleEvent,
  compileInboxEnqueuedEvent,
  compileInboxFailedEvent,
} from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { INBOX_SUMMARY_LIMIT, type InboxItem } from "@harness-anything/kernel/internal/domain/inbox.ts";
import { assertSessionContinuationFence } from "@harness-anything/kernel/internal/domain/runtime-session-continuation.ts";
import { currentExecutionArrangement } from "@harness-anything/kernel/internal/domain/task-execution-arrangement.ts";
import { runtimeExecutionLifetimeMs } from "./runtime-execution-credential.ts";
import { runtimeKindForId } from "../runtime-engine/runtime-inventory.ts";
import { notifyRuntimeCollectWaiters } from "./runtime-report-collect-action.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";

const TERMINAL_OR_FROZEN_TASK_STATUSES = new Set(["submitted", "in_review", "done", "cancelled", "archived"]);
const PREVIOUS_SUMMARY_LIMIT = 2000;
const QUEUED_STEER_PAGE_SIZE = 50;
const QUEUED_STEER_MAX_SCAN_PAGES = 200;
const QUEUED_STEER_LINEAGE_PATTERN = /^queued-steer:(dispatch_[a-f0-9]+):/u;
const RESUME_DOWNGRADE_ERROR_CODES = new Set(["runtime_resume_failed", "runtime_dispatch_not_resumable"]);

export type { RuntimeSteerMode };

/** Minimal identity key governing `--resume` provider-session inheritance across continuation turns. */
export interface ContinuationIdentityKey {
  readonly employeeId: string;
  readonly taskId: string;
  readonly dispatchLineage: string;
}

export function buildContinuationIdentityKey(input: {
  readonly employeeId: string | null;
  readonly taskId: string;
  readonly dispatchLineage: string;
}): ContinuationIdentityKey {
  return {
    employeeId: input.employeeId ?? "",
    taskId: input.taskId,
    dispatchLineage: input.dispatchLineage,
  };
}

export function continuationIdentityMatches(previous: ContinuationIdentityKey, next: ContinuationIdentityKey): boolean {
  return (
    previous.employeeId.length > 0 &&
    previous.employeeId === next.employeeId &&
    previous.taskId === next.taskId &&
    previous.dispatchLineage === next.dispatchLineage
  );
}

/** Roles/modes excluded from turn-end queued steer continuation cannot accept queued steers. */
export function queuedSteerTargetRefusalReason(input: {
  readonly role?: string | null;
  readonly permissionMode?: string | null;
}): string | null {
  if (input.role === "reviewer") return "Reviewer dispatches cannot consume queued steer instructions.";
  if (input.permissionMode === "read-only") return "Read-only dispatches cannot consume queued steer instructions.";
  return null;
}

export interface EnqueueQueuedSteerInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  readonly agentId: string | null;
  readonly role?: string | null;
  readonly permissionMode?: string | null;
  readonly idempotencyKey: string | null;
  readonly lane?: "steer" | "interrupt";
}

export interface EnqueueQueuedSteerResult {
  readonly opId: string;
  readonly inboxId: string;
  readonly inboxItemId: string;
  readonly revision: number;
  readonly proof: {
    readonly committedRevision: number;
    readonly appliedCut: number;
    readonly durable: true;
    readonly canonicalVisible: true;
    readonly worktreeVisible: null;
  };
  readonly evidence: string;
  readonly deduplicated: boolean;
}

export interface QueuedSteerTurnTrigger {
  readonly taskId: string;
  readonly previousDispatchId: string | null;
  readonly previousRuntimeSessionId: string | null;
  readonly previousKindId: string | null;
  readonly previousProviderSessionId: string | null;
  readonly previousAgentId: string | null;
  readonly previousRole?: string | null;
  readonly previousInstanceId: string | null;
  readonly previousModel: string | null;
  readonly previousPermissionMode: string | null;
  readonly previousMcpPolicy: string | null;
  readonly previousFinalText: string | null;
  readonly binding: RuntimeBinding;
}

function truncateText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(1, limit - 3)).trimEnd()}...`;
}

function resolveWorkId(projection: TaskProjection, taskId: string): string | null {
  const visited = new Set<string>();
  let cursor: string | null = taskId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const task: ReturnType<TaskProjection["read"]>["snapshot"]["task"] = projection.read(cursor).snapshot.task;
    if (!task) return null;
    const parentId: string | null = task.metadata?.parentTaskId ?? null;
    if (task.taskClass === "work" || parentId === null) return task.taskId;
    cursor = parentId;
  }
  return null;
}

/**
 * Atomically persist a steer prompt into Canonical Inbox (`task:<taskId>`) inside the
 * single-writer turn. Refuses non-consumable roles and frozen/terminal tasks before enqueue.
 */
export function enqueueQueuedSteer(
  context: RuntimeSpawnerContext,
  input: EnqueueQueuedSteerInput,
  binding: RuntimeBinding,
): EnqueueQueuedSteerResult {
  const store = context.requiredRuntimeStore(context.input),
    projection = context.requiredRuntimeProjection(context.input),
    inboxId = `task:${input.taskId}`,
    trimmedPrompt = input.prompt.trim(),
    now = context.input.now(),
    seed = input.idempotencyKey
      ? `${context.input.repoId}\0${inboxId}\0${input.idempotencyKey}`
      : `${context.input.repoId}\0${inboxId}\0${now}\0${randomUUID()}`,
    itemId = `steer_${sha256Text(seed).slice(0, 24)}`,
    dedupeKey = input.idempotencyKey ? `runtime-steer:${input.idempotencyKey}` : `runtime-steer:${itemId}`,
    opId = `runtime-steer-queue-${sha256Text(`${context.input.repoId}\0${inboxId}\0${dedupeKey}`).slice(0, 32)}`;

  if (input.lane !== "interrupt") {
    const refusalReason = queuedSteerTargetRefusalReason({
      role: input.role ?? null,
      permissionMode: input.permissionMode ?? null,
    });
    if (refusalReason !== null) throw context.runtimeSpawnError("runtime_steer_unsupported", refusalReason);
  }

  if (input.idempotencyKey) {
    const existingRead = projection.readInbox({ by: "dedupe", inboxId, dedupeKey });
    if (existingRead.status === "ready" && existingRead.items.length > 0) {
      const existing = existingRead.items[0]!;
      return {
        opId,
        inboxId,
        inboxItemId: existing.itemId,
        revision: existing.enqueuedRevision,
        proof: {
          committedRevision: existing.enqueuedRevision,
          appliedCut: existing.enqueuedRevision,
          durable: true,
          canonicalVisible: true,
          worktreeVisible: null,
        },
        evidence: `inbox:${inboxId}:${existing.itemId}`,
        deduplicated: true,
      };
    }
  }

  if (input.lane !== "interrupt") {
    const task = projection.read(input.taskId).snapshot.task;
    if (!task) throw context.runtimeSpawnError("task_not_found", `Task ${input.taskId} does not exist.`);
    if (TERMINAL_OR_FROZEN_TASK_STATUSES.has(task.status))
      throw context.runtimeSpawnError(
        "runtime_steer_unsupported",
        `Task ${input.taskId} is ${task.status} and cannot consume queued steer instructions.`,
      );
  }

  const headRevision = store.readHead()?.revision ?? 0,
    workspaceRevision = headRevision + 1,
    needsBlob = trimmedPrompt.length > INBOX_SUMMARY_LIMIT,
    promptBytes = needsBlob ? Buffer.from(trimmedPrompt, "utf8") : null,
    promptSha = promptBytes ? sha256Text(trimmedPrompt) : null,
    blobs: CanonicalContentBlob[] =
      promptBytes && promptSha
        ? [
            {
              sha256: promptSha,
              size: promptBytes.byteLength,
              mediaType: "text/plain; charset=utf-8",
              body: promptBytes,
            },
          ]
        : [],
    summary = truncateText(trimmedPrompt, INBOX_SUMMARY_LIMIT),
    workId = resolveWorkId(projection, input.taskId),
    sourceRef = input.dispatchId ? `dispatch/${input.dispatchId}` : `task/${input.taskId}`,
    event = compileInboxEnqueuedEvent({
      eventId: `event-${opId}`,
      workspaceRevision,
      opId,
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        inboxId,
        itemId,
        source: "runtime_steer",
        sourceRef,
        sourceEpoch: workspaceRevision,
        dedupeKey,
        admission: "dispatchable",
        consumerKind: "unattended_dispatch",
        taskId: input.taskId,
        agentId: input.agentId,
        senderPersonId: binding.actor.principal.personId,
        workId,
        lane: input.lane ?? "steer",
        correlationId: input.dispatchId ?? input.runtimeSessionId ?? input.taskId,
        minRevision: workspaceRevision,
        ...(promptSha && promptBytes
          ? {
              requiredBlobSha256s: [promptSha],
              bodyContentClaim: {
                sha256: promptSha,
                size: promptBytes.byteLength,
                mediaType: "text/plain; charset=utf-8",
              },
            }
          : {}),
        summary,
        enqueuedAt: now,
      },
    }),
    plan = canonicalEventWritePlan(event, "inbox", inboxId);

  const appended = store.append({ event, plan, blobs });
  projection.apply(event, plan);
  notifyRuntimeCollectWaiters(context.input.repoId, [input.taskId]);
  return {
    opId,
    inboxId,
    inboxItemId: itemId,
    revision: appended.revision,
    proof: {
      committedRevision: appended.revision,
      appliedCut: appended.revision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: null,
    },
    evidence: `inbox:${inboxId}:${itemId}`,
    deduplicated: false,
  };
}

export function readSteerItemPrompt(store: Pick<CanonicalEventStore, "readContentBlob">, item: InboxItem): string {
  const sha = item.requiredBlobSha256s[0];
  if (sha) {
    const blob = store.readContentBlob(sha);
    if (blob) return Buffer.from(blob).toString("utf8");
  }
  return item.summary;
}

export function buildQueuedSteerContinuationPrompt(input: {
  readonly taskId: string;
  readonly items: readonly { readonly item: InboxItem; readonly prompt: string }[];
  readonly previousTurnSummary: string | null;
  readonly degradedFreshTurn: boolean;
}): string {
  const lines: string[] = [`# Queued Steer Follow-up Turn (task:${input.taskId})`, ""];
  if (input.degradedFreshTurn) {
    lines.push("## Previous Turn Summary");
    lines.push(
      input.previousTurnSummary && input.previousTurnSummary.trim().length > 0
        ? truncateText(input.previousTurnSummary, PREVIOUS_SUMMARY_LIMIT)
        : "(No final summary was captured from the previous turn; inspect the workspace state before acting.)",
    );
    lines.push("");
  }
  lines.push(`## Queued Steer Instructions (Canonical Inbox task:${input.taskId})`);
  input.items.forEach(({ item, prompt }, index) => {
    lines.push(`${String(index + 1)}. [${item.enqueuedAt}] (${item.itemId}): ${prompt}`);
  });
  lines.push("");
  lines.push("Apply the queued steer instructions above cleanly from the current repository state.");
  return lines.join("\n");
}

function hasActiveRuntimeForTask(context: RuntimeSpawnerContext, taskId: string): boolean {
  for (const active of context.processes.values()) {
    if (active.task?.taskId === taskId) return true;
  }
  return false;
}

function taskAllowsQueuedSteerContinuation(projection: TaskProjection, taskId: string): boolean {
  const task = projection.read(taskId).snapshot.task;
  if (!task) return false;
  return !TERMINAL_OR_FROZEN_TASK_STATUSES.has(task.status);
}

interface DispatchLineage {
  readonly rootDispatchId: string;
  readonly dispatchIds: ReadonlySet<string>;
}

/**
 * Walk `resumedFromDispatchId` and queued-steer `dispatchKey` lineage anchors so multi-turn
 * continuations (`D1 -> D2 -> D3`) keep draining steers bound to earlier dispatches in the
 * same lineage without ever leaking across unrelated dispatches or employees.
 */
function resolveDispatchLineage(projection: TaskProjection, trigger: QueuedSteerTurnTrigger): DispatchLineage {
  const dispatchIds = new Set<string>();
  let rootDispatchId = trigger.previousDispatchId ?? trigger.taskId;
  const queue: string[] = trigger.previousDispatchId ? [trigger.previousDispatchId] : [];
  let steps = 0;
  while (queue.length > 0 && steps < 32) {
    const currentId = queue.shift()!;
    if (dispatchIds.has(currentId)) continue;
    dispatchIds.add(currentId);
    rootDispatchId = currentId;
    steps += 1;
    const row = projection.readRuntimeDispatchById?.(currentId);
    if (!row) continue;
    const resumedFrom = row.event.payload.resumedFromDispatchId;
    if (typeof resumedFrom === "string" && resumedFrom.length > 0 && !dispatchIds.has(resumedFrom))
      queue.push(resumedFrom);
    const dispatchKey = row.event.payload.dispatchKey;
    if (typeof dispatchKey === "string") {
      const match = QUEUED_STEER_LINEAGE_PATTERN.exec(dispatchKey);
      if (match && match[1] && !dispatchIds.has(match[1])) queue.push(match[1]);
    }
  }
  return { rootDispatchId, dispatchIds };
}

function matchesQueuedSteerTarget(item: InboxItem, trigger: QueuedSteerTurnTrigger, lineage: DispatchLineage): boolean {
  if (item.source !== "runtime_steer" || item.lane === "interrupt") return false;
  if (item.sourceRef.startsWith("dispatch/")) {
    const targetDispatchId = item.sourceRef.slice("dispatch/".length);
    if (!lineage.dispatchIds.has(targetDispatchId)) return false;
  }
  if (item.agentId !== null && trigger.previousAgentId !== item.agentId) return false;
  return true;
}

/**
 * Paginate through `task:<taskId>` pending queue following `nextCursor` so matching steers
 * behind >50 other pending items (e.g. reports, other sources, or other targets) are never missed.
 */
function collectMatchingPendingSteers(
  projection: TaskProjection,
  inboxId: string,
  trigger: QueuedSteerTurnTrigger,
  lineage: DispatchLineage,
  maxItems = QUEUED_STEER_PAGE_SIZE,
): readonly InboxItem[] {
  const matched: InboxItem[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < QUEUED_STEER_MAX_SCAN_PAGES; pageIndex += 1) {
    const read = projection.readInbox({
      by: "queue",
      status: "pending",
      consumerKind: "unattended_dispatch",
      inboxId,
      limit: QUEUED_STEER_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (read.status !== "ready") break;
    for (const item of read.items) {
      if (matchesQueuedSteerTarget(item, trigger, lineage)) {
        matched.push(item);
        if (matched.length >= maxItems) return matched;
      }
    }
    if (read.nextCursor === null || read.items.length === 0) break;
    cursor = read.nextCursor;
  }
  return matched;
}

function errorCodeOf(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : fallback;
}

function stripStaleContinuationBinding(binding: RuntimeBinding): RuntimeBinding {
  const {
    authorizationDecision: _staleAuth,
    executionPrincipal: _stalePrincipal,
    ...rest
  } = binding as RuntimeBinding & { readonly executionPrincipal?: unknown };
  return {
    ...rest,
    actor: { principal: binding.actor.principal, executor: null },
  };
}

/**
 * Atomically claim pending `runtime_steer` items from `task:<taskId>` across pages and start at
 * most one follow-up turn per task. Enforces `(employeeId, taskId, dispatchLineage)` continuation
 * identity, re-authorizes at the current cut via `authorizeRuntimeContinuation`, preserves the
 * managed worktree on fresh continuations, writes an immutable audit event on `--resume -> fresh`
 * downgrade, and settles every claimed/terminal item to an observable inbox outcome.
 */
export async function consumeQueuedSteersAfterTurn(
  context: RuntimeSpawnerContext,
  trigger: QueuedSteerTurnTrigger,
): Promise<{
  readonly spawnedDispatchId: string;
  readonly consumedItemIds: readonly string[];
  readonly degraded: boolean;
  readonly downgradedFromResume?: boolean;
  readonly downgradeAuditItemId?: string;
} | null> {
  if (context.closed?.() || context.input.remote || !context.spawnQueuedSteerTurn) return null;
  if (
    queuedSteerTargetRefusalReason({
      role: trigger.previousRole ?? null,
      permissionMode: trigger.previousPermissionMode,
    }) !== null
  )
    return null;
  const inboxId = `task:${trigger.taskId}`,
    inFlight = context.queuedSteerInFlight;
  if (inFlight?.has(inboxId)) return null;
  if (hasActiveRuntimeForTask(context, trigger.taskId)) return null;

  const projection = context.requiredRuntimeProjection(context.input),
    lineage = resolveDispatchLineage(projection, trigger),
    daemonBinding = stripStaleContinuationBinding(trigger.binding),
    runWrite = <T>(work: () => T): Promise<T> =>
      context.input.writeRuntime ? context.input.writeRuntime(work, daemonBinding) : Promise.resolve(work());

  if (!taskAllowsQueuedSteerContinuation(projection, trigger.taskId)) {
    const staleItems = collectMatchingPendingSteers(projection, inboxId, trigger, lineage);
    if (staleItems.length === 0) return null;
    inFlight?.add(inboxId);
    try {
      await runWrite(() => {
        const currentProjection = context.requiredRuntimeProjection(context.input);
        if (taskAllowsQueuedSteerContinuation(currentProjection, trigger.taskId)) return;
        const store = context.requiredRuntimeStore(context.input),
          currentLineage = resolveDispatchLineage(currentProjection, trigger),
          pending = collectMatchingPendingSteers(currentProjection, inboxId, trigger, currentLineage);
        if (pending.length === 0) return;
        const droppedAt = context.input.now();
        let rev = store.readHead()?.revision ?? 0;
        const bundles = pending.map((item) => {
          rev += 1;
          const opId = `inbox-drop-terminal-${item.itemId}-${String(rev)}`;
          const event = compileInboxDroppedStaleEvent({
            eventId: `event-${opId}`,
            workspaceRevision: rev,
            opId,
            actor: daemonBinding.actor,
            source: daemonBinding.source,
            occurredAt: droppedAt,
            payload: {
              inboxId,
              itemId: item.itemId,
              claimId: null,
              reasonCode: "target_terminal",
              observedSourceEpoch: null,
              droppedAt,
            },
          });
          return { event, plan: canonicalEventWritePlan(event, "inbox", inboxId), blobs: [] as const };
        });
        const final = bundles[bundles.length - 1]!;
        store.append({ ...final, preceding: bundles.slice(0, -1) });
        for (const bundle of bundles) currentProjection.apply(bundle.event, bundle.plan);
      });
    } finally {
      inFlight?.delete(inboxId);
    }
    return null;
  }

  const peek = collectMatchingPendingSteers(projection, inboxId, trigger, lineage, 1);
  if (peek.length === 0) return null;

  inFlight?.add(inboxId);
  const claimId = `steer-turn-${randomUUID().slice(0, 12)}`;
  const lineageDispatchKey = `queued-steer:${lineage.rootDispatchId}:${claimId}`;

  let claimedItems: { readonly item: InboxItem; readonly prompt: string }[] = [];
  try {
    const claimWork = (): { readonly item: InboxItem; readonly prompt: string }[] => {
      if (hasActiveRuntimeForTask(context, trigger.taskId)) return [];
      const currentProjection = context.requiredRuntimeProjection(context.input);
      if (!taskAllowsQueuedSteerContinuation(currentProjection, trigger.taskId)) return [];
      const store = context.requiredRuntimeStore(context.input),
        currentLineage = resolveDispatchLineage(currentProjection, trigger),
        pending = collectMatchingPendingSteers(currentProjection, inboxId, trigger, currentLineage);
      if (pending.length === 0) return [];
      const claimedAt = context.input.now(),
        leaseUntil = new Date(Date.parse(claimedAt) + runtimeExecutionLifetimeMs).toISOString();
      let rev = store.readHead()?.revision ?? 0;
      const bundles = pending.map((item) => {
        rev += 1;
        const opId = `inbox-claim-${claimId}-${item.itemId}`;
        const event = compileInboxClaimedEvent({
          eventId: `event-${opId}`,
          workspaceRevision: rev,
          opId,
          actor: daemonBinding.actor,
          source: daemonBinding.source,
          occurredAt: claimedAt,
          payload: { inboxId, itemId: item.itemId, claimId, claimedAt, leaseUntil },
        });
        return { event, plan: canonicalEventWritePlan(event, "inbox", inboxId), blobs: [] as const };
      });
      const final = bundles[bundles.length - 1]!;
      store.append({ ...final, preceding: bundles.slice(0, -1) });
      for (const bundle of bundles) currentProjection.apply(bundle.event, bundle.plan);
      return pending.map((item) => ({ item, prompt: readSteerItemPrompt(store, item) }));
    };

    claimedItems = await runWrite(claimWork);
    if (claimedItems.length === 0) return null;

    const currentProjection = context.requiredRuntimeProjection(context.input),
      taskSnapshot = currentProjection.read(trigger.taskId).snapshot,
      arrangementAgentId = currentExecutionArrangement(taskSnapshot)?.agentId ?? null,
      effectiveAgentId = arrangementAgentId ?? trigger.previousAgentId ?? null,
      kind = trigger.previousKindId ? runtimeKindForId(trigger.previousKindId) : null,
      previousIdentity = buildContinuationIdentityKey({
        employeeId: trigger.previousAgentId ?? trigger.previousInstanceId,
        taskId: trigger.taskId,
        dispatchLineage: lineage.rootDispatchId,
      }),
      nextIdentity = buildContinuationIdentityKey({
        employeeId: effectiveAgentId ?? trigger.previousInstanceId,
        taskId: trigger.taskId,
        dispatchLineage: lineage.rootDispatchId,
      }),
      fenceVerdict = assertSessionContinuationFence({
        origin: "unattended_inbox_wakeup",
        requestedAgentId: effectiveAgentId,
        previousAgentId: trigger.previousAgentId,
        taskId: trigger.taskId,
        previousTaskId: trigger.taskId,
        dispatchLineageMatches: continuationIdentityMatches(previousIdentity, nextIdentity),
        providerSessionId: trigger.previousProviderSessionId,
        runtimeSupportsResume: kind?.steerSupported === true,
        priorStopProof: "proven_stopped",
        priorTerminalKind: trigger.previousDispatchId ? "completed_turn" : "none",
        hasHandoffPacket: false,
      }),
      canInPlaceResume = Boolean(
        fenceVerdict.governed &&
          fenceVerdict.allowProviderResume &&
          continuationIdentityMatches(previousIdentity, nextIdentity) &&
          trigger.previousProviderSessionId &&
          trigger.previousDispatchId &&
          kind?.steerSupported === true,
      );

    const authorizeContinuation = async (payload: JsonObject, attemptSuffix: string): Promise<RuntimeBinding> => {
      if (!context.input.authorizeRuntimeContinuation)
        throw context.runtimeSpawnError(
          "authorization_missing",
          "Queued steer continuation requires center authorizeRuntimeContinuation at the current cut.",
        );
      const authorized = await context.input.authorizeRuntimeContinuation(
        payload,
        daemonBinding,
        `queued-steer-continuation:${claimId}:${attemptSuffix}`,
      );
      if (!authorized?.authorizationDecision || authorized.authorizationDecision.outcome !== "allowed") {
        const detail =
          authorized?.authorizationDecision?.nextActions.join(" ") ||
          "Queued steer continuation was denied by the current authorization policy.";
        throw context.runtimeSpawnError("authorization_denied", detail);
      }
      return authorized;
    };

    const buildFreshPayload = (degradedPrompt: string, keySuffix = ""): JsonObject => ({
      taskId: trigger.taskId,
      prompt: degradedPrompt,
      dispatchKey: keySuffix ? `${lineageDispatchKey}:${keySuffix}` : lineageDispatchKey,
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      ...(!effectiveAgentId && trigger.previousInstanceId ? { runtimeInstanceId: trigger.previousInstanceId } : {}),
      ...(trigger.previousModel ? { model: trigger.previousModel } : {}),
      ...(trigger.previousPermissionMode ? { permissionMode: trigger.previousPermissionMode } : {}),
      ...(trigger.previousMcpPolicy ? { mcpPolicy: trigger.previousMcpPolicy } : {}),
    });

    const recordResumeDowngradeAudit = async (reasonCode: string): Promise<string> =>
      runWrite(() => {
        const store = context.requiredRuntimeStore(context.input),
          proj = context.requiredRuntimeProjection(context.input),
          occurredAt = context.input.now(),
          rev = (store.readHead()?.revision ?? 0) + 1,
          auditItemId = `audit_resume_downgrade_${sha256Text(`${claimId}\0${trigger.previousDispatchId ?? ""}\0${String(rev)}`).slice(0, 20)}`,
          opId = `inbox-audit-resume-downgrade-${claimId}`,
          workId = resolveWorkId(proj, trigger.taskId),
          auditEvent = compileInboxEnqueuedEvent({
            eventId: `event-${opId}`,
            workspaceRevision: rev,
            opId,
            actor: daemonBinding.actor,
            source: daemonBinding.source,
            occurredAt,
            payload: {
              inboxId,
              itemId: auditItemId,
              source: "runtime_report",
              sourceRef: `audit/resume-downgrade/${trigger.previousDispatchId ?? trigger.taskId}`,
              sourceEpoch: rev,
              dedupeKey: `audit-resume-downgrade:${claimId}:${trigger.previousDispatchId ?? trigger.taskId}`,
              admission: "dispatchable",
              consumerKind: "interactive_watch",
              taskId: trigger.taskId,
              agentId: effectiveAgentId,
              senderPersonId: daemonBinding.actor.principal.personId,
              workId,
              lane: "resume_downgrade",
              correlationId: lineage.rootDispatchId,
              minRevision: rev,
              summary: truncateText(
                `[resume-downgrade] employee=${previousIdentity.employeeId} task=${trigger.taskId} lineage=${lineage.rootDispatchId} dispatch=${trigger.previousDispatchId ?? "none"} reason=${reasonCode} downgraded=fresh`,
                INBOX_SUMMARY_LIMIT,
              ),
              enqueuedAt: occurredAt,
            },
          }),
          auditPlan = canonicalEventWritePlan(auditEvent, "inbox", inboxId);
        store.append({ event: auditEvent, plan: auditPlan, blobs: [] });
        proj.apply(auditEvent, auditPlan);
        return auditItemId;
      });

    let degraded = !canInPlaceResume;
    let downgradedFromResume = false;
    let downgradeAuditItemId: string | undefined;
    let spawned: JsonObject;

    if (canInPlaceResume) {
      const resumePrompt = buildQueuedSteerContinuationPrompt({
        taskId: trigger.taskId,
        items: claimedItems,
        previousTurnSummary: trigger.previousFinalText,
        degradedFreshTurn: false,
      });
      const resumePayload: JsonObject = {
        dispatchId: trigger.previousDispatchId!,
        taskId: trigger.taskId,
        prompt: resumePrompt,
        dispatchKey: lineageDispatchKey,
        ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      };
      const authorizedResume = await authorizeContinuation(resumePayload, "resume");
      const spawnTurn = context.spawnQueuedSteerTurn;
      const attemptResume = async (): Promise<
        | { readonly resumed: JsonObject; readonly downgradeReasonCode: null }
        | { readonly resumed: null; readonly downgradeReasonCode: string }
      > => {
        try {
          return {
            resumed: await spawnTurn(resumePayload, authorizedResume, { recoveryRequested: false }),
            downgradeReasonCode: null,
          };
        } catch (resumeError) {
          const resumeErrorCode = errorCodeOf(resumeError, "runtime_resume_failed");
          if (!RESUME_DOWNGRADE_ERROR_CODES.has(resumeErrorCode)) throw resumeError;
          return { resumed: null, downgradeReasonCode: resumeErrorCode };
        }
      };
      const resumeAttempt = await attemptResume();
      if (resumeAttempt.resumed !== null) {
        spawned = resumeAttempt.resumed;
      } else {
        downgradedFromResume = true;
        degraded = true;
        downgradeAuditItemId = await recordResumeDowngradeAudit(resumeAttempt.downgradeReasonCode);
        const freshPrompt = buildQueuedSteerContinuationPrompt({
          taskId: trigger.taskId,
          items: claimedItems,
          previousTurnSummary: trigger.previousFinalText,
          degradedFreshTurn: true,
        });
        const freshPayload = buildFreshPayload(freshPrompt, "fresh-fallback");
        const authorizedFresh = await authorizeContinuation(freshPayload, "fresh-fallback");
        spawned = await context.spawnQueuedSteerTurn(freshPayload, authorizedFresh, { recoveryRequested: true });
      }
    } else {
      const freshPrompt = buildQueuedSteerContinuationPrompt({
        taskId: trigger.taskId,
        items: claimedItems,
        previousTurnSummary: trigger.previousFinalText,
        degradedFreshTurn: true,
      });
      const freshPayload = buildFreshPayload(freshPrompt);
      const authorizedFresh = await authorizeContinuation(freshPayload, "fresh");
      spawned = await context.spawnQueuedSteerTurn(freshPayload, authorizedFresh, { recoveryRequested: true });
    }

    const spawnedDispatchId = typeof spawned.dispatchId === "string" ? spawned.dispatchId : null;
    await runWrite(() => {
      const store = context.requiredRuntimeStore(context.input),
        proj = context.requiredRuntimeProjection(context.input),
        completedAt = context.input.now();
      let rev = store.readHead()?.revision ?? 0;
      const bundles = claimedItems.map(({ item }) => {
        rev += 1;
        const opId = `inbox-complete-${claimId}-${item.itemId}`;
        const event = compileInboxCompletedEvent({
          eventId: `event-${opId}`,
          workspaceRevision: rev,
          opId,
          actor: daemonBinding.actor,
          source: daemonBinding.source,
          occurredAt: completedAt,
          payload: {
            inboxId,
            itemId: item.itemId,
            claimId,
            dispatchId: spawnedDispatchId,
            completedAt,
          },
        });
        return { event, plan: canonicalEventWritePlan(event, "inbox", inboxId), blobs: [] as const };
      });
      const final = bundles[bundles.length - 1]!;
      store.append({ ...final, preceding: bundles.slice(0, -1) });
      for (const bundle of bundles) proj.apply(bundle.event, bundle.plan);
    });

    return {
      spawnedDispatchId: spawnedDispatchId ?? "",
      consumedItemIds: claimedItems.map(({ item }) => item.itemId),
      degraded,
      ...(downgradedFromResume ? { downgradedFromResume: true, downgradeAuditItemId } : {}),
    };
  } catch (error) {
    if (claimedItems.length > 0) {
      const reasonCode = errorCodeOf(error, "queued_steer_spawn_failed");
      await runWrite(() => {
        const store = context.requiredRuntimeStore(context.input),
          proj = context.requiredRuntimeProjection(context.input),
          failedAt = context.input.now();
        let rev = store.readHead()?.revision ?? 0;
        const bundles = claimedItems.map(({ item }) => {
          rev += 1;
          const opId = `inbox-fail-${claimId}-${item.itemId}`;
          const event = compileInboxFailedEvent({
            eventId: `event-${opId}`,
            workspaceRevision: rev,
            opId,
            actor: daemonBinding.actor,
            source: daemonBinding.source,
            occurredAt: failedAt,
            payload: { inboxId, itemId: item.itemId, claimId, reasonCode, failedAt },
          });
          return { event, plan: canonicalEventWritePlan(event, "inbox", inboxId), blobs: [] as const };
        });
        const final = bundles[bundles.length - 1]!;
        store.append({ ...final, preceding: bundles.slice(0, -1) });
        for (const bundle of bundles) proj.apply(bundle.event, bundle.plan);
      });
    }
    throw error;
  } finally {
    inFlight?.delete(inboxId);
  }
}

/** Build the command-receipt/v2 returned when a steer is durably queued into Canonical Inbox. */
export function buildQueuedSteerReceipt(input: {
  readonly queued: EnqueueQueuedSteerResult;
  readonly taskId: string;
  readonly runtimeSessionId: string | null;
  readonly dispatchId: string | null;
  readonly steerTarget?: JsonObject;
}): JsonObject {
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-steer",
    outcome: "queued",
    mode: "queue",
    opId: input.queued.opId,
    inboxId: input.queued.inboxId,
    inboxItemId: input.queued.inboxItemId,
    taskId: input.taskId,
    ...(input.runtimeSessionId ? { runtimeSessionId: input.runtimeSessionId } : {}),
    ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
    revision: input.queued.revision,
    proof: input.queued.proof,
    visibility: "center",
    evidence: input.queued.evidence,
    summary: `Steer queued in inbox ${input.queued.inboxId} (${input.queued.inboxItemId}); will be consumed at the next turn boundary without interrupting the running process.`,
    ...(input.steerTarget ? { steerTarget: input.steerTarget } : {}),
  };
}
