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
  compileInboxEnqueuedEvent,
  compileInboxFailedEvent,
} from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { INBOX_SUMMARY_LIMIT, type InboxItem } from "@harness-anything/kernel/internal/domain/inbox.ts";
import { runtimeExecutionLifetimeMs } from "./runtime-execution-credential.ts";
import { runtimeKindForId } from "../runtime-engine/runtime-inventory.ts";
import { notifyRuntimeCollectWaiters } from "./runtime-report-collect-action.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";

const TERMINAL_OR_FROZEN_TASK_STATUSES = new Set(["submitted", "in_review", "done", "cancelled", "archived"]);
const PREVIOUS_SUMMARY_LIMIT = 2000;

export type { RuntimeSteerMode };

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
 * single-writer turn. Large prompts are stored losslessly in a content blob alongside a bounded summary.
 */
export function enqueueQueuedSteer(
  context: RuntimeSpawnerContext,
  input: EnqueueQueuedSteerInput,
  binding: RuntimeBinding,
): EnqueueQueuedSteerResult {
  if (input.lane !== "interrupt") {
    const refusalReason = queuedSteerTargetRefusalReason({
      role: input.role ?? null,
      permissionMode: input.permissionMode ?? null,
    });
    if (refusalReason !== null) throw context.runtimeSpawnError("runtime_steer_unsupported", refusalReason);
  }
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

function matchesQueuedSteerTarget(item: InboxItem, trigger: QueuedSteerTurnTrigger): boolean {
  if (item.source !== "runtime_steer" || item.lane === "interrupt") return false;
  if (item.sourceRef.startsWith("dispatch/")) {
    const targetDispatchId = item.sourceRef.slice("dispatch/".length);
    if (!trigger.previousDispatchId || trigger.previousDispatchId !== targetDispatchId) return false;
  }
  if (item.agentId !== null && trigger.previousAgentId !== item.agentId) return false;
  return true;
}

/**
 * Atomically claim pending `runtime_steer` items from `task:<taskId>` and start at most one
 * follow-up turn per task. Supports in-place providerSessionId resume when available and falls
 * back smoothly to a fresh Turn with recent-turn summary + unread Inbox queue (e.g. for `agy`).
 */
export async function consumeQueuedSteersAfterTurn(
  context: RuntimeSpawnerContext,
  trigger: QueuedSteerTurnTrigger,
): Promise<{
  readonly spawnedDispatchId: string;
  readonly consumedItemIds: readonly string[];
  readonly degraded: boolean;
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

  const projection = context.requiredRuntimeProjection(context.input);
  if (!taskAllowsQueuedSteerContinuation(projection, trigger.taskId)) return null;
  const peek = projection.readInbox({
    by: "queue",
    status: "pending",
    consumerKind: "unattended_dispatch",
    inboxId,
    limit: 50,
  });
  if (peek.status !== "ready" || !peek.items.some((item) => matchesQueuedSteerTarget(item, trigger))) return null;

  inFlight?.add(inboxId);
  const claimId = `steer-turn-${randomUUID().slice(0, 12)}`;
  const daemonBinding: RuntimeBinding = {
    ...trigger.binding,
    actor: { principal: trigger.binding.actor.principal, executor: null },
  };

  let claimedItems: { readonly item: InboxItem; readonly prompt: string }[] = [];
  try {
    const claimWork = (): { readonly item: InboxItem; readonly prompt: string }[] => {
      if (hasActiveRuntimeForTask(context, trigger.taskId)) return [];
      const currentProjection = context.requiredRuntimeProjection(context.input);
      if (!taskAllowsQueuedSteerContinuation(currentProjection, trigger.taskId)) return [];
      const store = context.requiredRuntimeStore(context.input),
        queueRead = currentProjection.readInbox({
          by: "queue",
          status: "pending",
          consumerKind: "unattended_dispatch",
          inboxId,
          limit: 50,
        });
      if (queueRead.status !== "ready") return [];
      const pending = queueRead.items.filter((item) => matchesQueuedSteerTarget(item, trigger));
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

    const runWrite = <T>(work: () => T): Promise<T> =>
      context.input.writeRuntime ? context.input.writeRuntime(work, daemonBinding) : Promise.resolve(work());

    claimedItems = await runWrite(claimWork);
    if (claimedItems.length === 0) return null;

    const kind = trigger.previousKindId ? runtimeKindForId(trigger.previousKindId) : null;
    const canInPlaceResume = Boolean(
      trigger.previousProviderSessionId && trigger.previousDispatchId && kind?.steerSupported === true,
    );

    const buildFreshPayload = (degradedPrompt: string): JsonObject => ({
      taskId: trigger.taskId,
      prompt: degradedPrompt,
      dispatchKey: `queued-steer-${claimId}`,
      ...(trigger.previousAgentId ? { agentId: trigger.previousAgentId } : {}),
      ...(!trigger.previousAgentId && trigger.previousInstanceId
        ? { runtimeInstanceId: trigger.previousInstanceId }
        : {}),
      ...(trigger.previousModel ? { model: trigger.previousModel } : {}),
      ...(trigger.previousPermissionMode ? { permissionMode: trigger.previousPermissionMode } : {}),
      ...(trigger.previousMcpPolicy ? { mcpPolicy: trigger.previousMcpPolicy } : {}),
    });

    const degraded = !canInPlaceResume;
    const continuationPrompt = buildQueuedSteerContinuationPrompt({
      taskId: trigger.taskId,
      items: claimedItems,
      previousTurnSummary: trigger.previousFinalText,
      degradedFreshTurn: degraded,
    });
    const spawned: JsonObject = canInPlaceResume
      ? await context.spawnQueuedSteerTurn(
          {
            dispatchId: trigger.previousDispatchId!,
            taskId: trigger.taskId,
            prompt: continuationPrompt,
            dispatchKey: `queued-steer-${claimId}`,
            ...(trigger.previousAgentId ? { agentId: trigger.previousAgentId } : {}),
          },
          daemonBinding,
          { recoveryRequested: false },
        )
      : await context.spawnQueuedSteerTurn(buildFreshPayload(continuationPrompt), daemonBinding, {
          recoveryRequested: true,
        });

    const spawnedDispatchId = typeof spawned.dispatchId === "string" ? spawned.dispatchId : null;
    await runWrite(() => {
      const store = context.requiredRuntimeStore(context.input),
        currentProjection = context.requiredRuntimeProjection(context.input),
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
      for (const bundle of bundles) currentProjection.apply(bundle.event, bundle.plan);
    });

    return {
      spawnedDispatchId: spawnedDispatchId ?? "",
      consumedItemIds: claimedItems.map(({ item }) => item.itemId),
      degraded,
    };
  } catch (error) {
    if (claimedItems.length) {
      const reasonCode =
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : "queued_steer_spawn_failed";
      if (context.input.writeRuntime) {
        await context.input.writeRuntime(() => {
          const store = context.requiredRuntimeStore(context.input),
            currentProjection = context.requiredRuntimeProjection(context.input),
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
          for (const bundle of bundles) currentProjection.apply(bundle.event, bundle.plan);
        }, daemonBinding);
      }
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
