/**
 * Canonical Inbox domain aggregate and deterministic reducer (dec_E0CB793DAA21F49FF1E98D5067).
 *
 * All Inbox state is folded from `runtime_inbox_enqueued`, `runtime_inbox_claimed`, and
 * `runtime_inbox_settled` canonical events under `agent-runtime-event/v1`. Every backend
 * projection (SQLite increment/rebuild, PG, PGlite) runs this same reducer.
 */
import type { AgentRuntimeEventV1 } from "./agent-runtime.ts";

export const RUNTIME_INBOX_MODEL_VERSION = 1;
export const RUNTIME_INBOX_PAGE_LIMIT = 200;

export const runtimeInboxItemStatuses = ["pending", "leased", "consumed", "dead_letter"] as const;
export type RuntimeInboxItemStatus = (typeof runtimeInboxItemStatuses)[number];
export type RuntimeInboxSource = "ruling_resolved" | "timer_fired" | "task_stalled" | "inbound_message" | "system";
export type RuntimeInboxMidRunPolicy = "defer_next_run" | "fold" | "interrupt";
export type RuntimeInboxSettlementKind = "consumed" | "dead_letter" | "released";

export const runtimeInboxEventTypes = [
  "runtime_inbox_enqueued",
  "runtime_inbox_claimed",
  "runtime_inbox_settled",
] as const satisfies readonly AgentRuntimeEventV1["type"][];

export type RuntimeInboxEventType = (typeof runtimeInboxEventTypes)[number];
export type RuntimeInboxInput = Extract<AgentRuntimeEventV1, { readonly type: RuntimeInboxEventType }>;

export function isRuntimeInboxInput(event: {
  readonly schema: string;
  readonly type: string;
}): event is RuntimeInboxInput {
  return (
    event.schema === "agent-runtime-event/v1" && (runtimeInboxEventTypes as readonly string[]).includes(event.type)
  );
}

export interface RuntimeInboxItem {
  readonly itemId: string;
  readonly source: RuntimeInboxSource;
  readonly dedupeKey: string;
  readonly coalesceWindowMs: number;
  readonly midRunPolicy: RuntimeInboxMidRunPolicy;
  readonly taskId: string | null;
  readonly dispatchId: string | null;
  readonly squadRunId: string | null;
  readonly agentId: string | null;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly contextRef: string | null;
  readonly enqueuedAt: string;
  readonly enqueuedRevision: number;
  readonly status: RuntimeInboxItemStatus;
  readonly claimFence: number | null;
  readonly leaseUntil: string | null;
  readonly settledByDispatchId: string | null;
  readonly settlementReason: string | null;
  readonly settledAt: string | null;
}

export interface RuntimeInboxActiveClaim {
  readonly claimFence: number;
  readonly itemIds: readonly string[];
  readonly claimedByDispatchId: string | null;
  readonly claimedAt: string;
  readonly leaseUntil: string;
}

export interface RuntimeInboxGroup {
  readonly inboxId: string;
  readonly currentClaimFence: number;
  readonly activeClaim: RuntimeInboxActiveClaim | null;
  readonly lastRevision: number;
  readonly items: readonly RuntimeInboxItem[];
}

export type RuntimeInboxQuery =
  | { readonly by: "inbox"; readonly inboxId: string }
  | { readonly by: "open"; readonly limit?: number; readonly cursor?: string };

export type RuntimeInboxRead =
  | { readonly status: "pending"; readonly watermark: number; readonly sourceRevision: number }
  | {
      readonly status: "ready";
      readonly watermark: number;
      readonly sourceRevision: number;
      readonly rows: readonly RuntimeInboxGroup[];
      readonly nextCursor: string | null;
    };

export type RuntimeInboxStep =
  | { readonly kind: "applied"; readonly group: RuntimeInboxGroup }
  | { readonly kind: "ignored"; readonly reason: string };

export type RuntimeInboxBatchEvaluation =
  | {
      readonly ready: true;
      readonly nextClaimFence: number;
      readonly items: readonly RuntimeInboxItem[];
    }
  | {
      readonly ready: false;
      readonly reason: "empty" | "leased" | "deferred_mid_run" | "awaiting_proven_stopped" | "coalescing";
      readonly wakeAt: string | null;
    };

/** Deterministically fold one canonical Inbox event into the inbox's materialized aggregate. */
export function reduceRuntimeInbox(previous: RuntimeInboxGroup | null, event: RuntimeInboxInput): RuntimeInboxStep {
  if (event.type === "runtime_inbox_enqueued") {
    const payload = event.payload,
      inbox = previous ?? {
        inboxId: payload.inboxId,
        currentClaimFence: 0,
        activeClaim: null,
        lastRevision: 0,
        items: [],
      };
    if (inbox.inboxId !== payload.inboxId) return { kind: "ignored", reason: "inbox_id_mismatch" };
    if (inbox.items.some((item) => item.itemId === payload.itemId))
      return { kind: "ignored", reason: "duplicate_item_id" };
    if (inbox.items.some((item) => item.dedupeKey === payload.dedupeKey && item.status !== "dead_letter"))
      return { kind: "ignored", reason: "duplicate_dedupe_key" };
    const item: RuntimeInboxItem = {
      itemId: payload.itemId,
      source: payload.source,
      dedupeKey: payload.dedupeKey,
      coalesceWindowMs: payload.coalesceWindowMs,
      midRunPolicy: payload.midRunPolicy,
      taskId: payload.taskId,
      dispatchId: payload.dispatchId,
      squadRunId: payload.squadRunId,
      agentId: payload.agentId,
      summary: payload.summary,
      data: payload.data,
      contextRef: payload.contextRef ?? null,
      enqueuedAt: payload.enqueuedAt,
      enqueuedRevision: event.workspaceRevision,
      status: "pending",
      claimFence: null,
      leaseUntil: null,
      settledByDispatchId: null,
      settlementReason: null,
      settledAt: null,
    };
    return {
      kind: "applied",
      group: {
        ...inbox,
        lastRevision: Math.max(inbox.lastRevision, event.workspaceRevision),
        items: [...inbox.items, item],
      },
    };
  }

  if (previous === null || previous.inboxId !== event.payload.inboxId)
    return { kind: "ignored", reason: "inbox_missing" };

  if (event.type === "runtime_inbox_claimed") {
    const payload = event.payload,
      claimedMs = Date.parse(payload.claimedAt);
    if (payload.claimFence <= previous.currentClaimFence) return { kind: "ignored", reason: "stale_claim_fence" };
    if (previous.activeClaim !== null && Date.parse(previous.activeClaim.leaseUntil) > claimedMs)
      return { kind: "ignored", reason: "active_claim_unexpired" };
    const selected = new Set(payload.itemIds);
    const items = previous.items.map((item): RuntimeInboxItem => {
      if (!selected.has(item.itemId)) return item;
      if (item.status !== "pending" && item.status !== "leased") return item;
      return {
        ...item,
        status: "leased",
        claimFence: payload.claimFence,
        leaseUntil: payload.leaseUntil,
      };
    });
    const leasedIds = items
      .filter((item) => selected.has(item.itemId) && item.claimFence === payload.claimFence && item.status === "leased")
      .map((item) => item.itemId);
    if (leasedIds.length === 0) return { kind: "ignored", reason: "no_claimable_items" };
    return {
      kind: "applied",
      group: {
        ...previous,
        currentClaimFence: payload.claimFence,
        activeClaim: {
          claimFence: payload.claimFence,
          itemIds: leasedIds,
          claimedByDispatchId: payload.claimedByDispatchId,
          claimedAt: payload.claimedAt,
          leaseUntil: payload.leaseUntil,
        },
        lastRevision: Math.max(previous.lastRevision, event.workspaceRevision),
        items,
      },
    };
  }

  const payload = event.payload;
  if (!previous.activeClaim || previous.activeClaim.claimFence !== payload.claimFence)
    return { kind: "ignored", reason: "claim_fence_mismatch" };
  const targetIds = new Set(payload.itemIds);
  const nextStatus: RuntimeInboxItemStatus = payload.settlement === "released" ? "pending" : payload.settlement;
  let changed = false;
  const items = previous.items.map((item): RuntimeInboxItem => {
    if (!targetIds.has(item.itemId) || item.status !== "leased" || item.claimFence !== payload.claimFence) return item;
    changed = true;
    return {
      ...item,
      status: nextStatus,
      claimFence: payload.settlement === "released" ? null : item.claimFence,
      leaseUntil: null,
      settledByDispatchId: payload.settlement === "released" ? null : payload.settledByDispatchId,
      settlementReason: payload.settlement === "released" ? null : payload.reason,
      settledAt: payload.settlement === "released" ? null : payload.settledAt,
    };
  });
  if (!changed) return { kind: "ignored", reason: "no_leased_items_matched" };
  const stillLeased = items.some((item) => item.status === "leased" && item.claimFence === payload.claimFence);
  return {
    kind: "applied",
    group: {
      ...previous,
      activeClaim: stillLeased ? previous.activeClaim : null,
      lastRevision: Math.max(previous.lastRevision, event.workspaceRevision),
      items,
    },
  };
}

/** Whether any item in the inbox group has not yet reached a terminal settlement (`consumed` | `dead_letter`). */
export function inboxHasOpenItems(group: RuntimeInboxGroup): boolean {
  return group.items.some((item) => item.status === "pending" || item.status === "leased");
}

/**
 * The one dispatcher batch-admission judgment shared across workers: enforces unexpired claim leases,
 * `midRunPolicy` deferral while an attempt runs, `stopProof === "proven_stopped"`, and coalesce windows.
 */
export function evaluateRuntimeInboxBatch(
  group: RuntimeInboxGroup,
  input: {
    readonly now: string;
    readonly hasRunningAttempt: boolean;
    readonly priorStopProof: "proven_stopped" | "unproven" | "none";
  },
): RuntimeInboxBatchEvaluation {
  const nowMs = Date.parse(input.now);
  const activeClaim = group.activeClaim;
  if (activeClaim !== null && Date.parse(activeClaim.leaseUntil) > nowMs)
    return { ready: false, reason: "leased", wakeAt: activeClaim.leaseUntil };
  const expiredLease = activeClaim !== null && Date.parse(activeClaim.leaseUntil) <= nowMs;
  const candidates = group.items.filter(
    (item) => item.status === "pending" || (expiredLease && item.status === "leased"),
  );
  if (candidates.length === 0) return { ready: false, reason: "empty", wakeAt: null };
  if (input.hasRunningAttempt && !candidates.some((item) => item.midRunPolicy === "interrupt"))
    return { ready: false, reason: "deferred_mid_run", wakeAt: null };
  if (input.priorStopProof === "unproven") return { ready: false, reason: "awaiting_proven_stopped", wakeAt: null };
  let latestReadyMs = 0;
  for (const item of candidates) {
    const readyMs = Date.parse(item.enqueuedAt) + item.coalesceWindowMs;
    if (readyMs > latestReadyMs) latestReadyMs = readyMs;
  }
  if (Number.isFinite(latestReadyMs) && nowMs < latestReadyMs)
    return { ready: false, reason: "coalescing", wakeAt: new Date(latestReadyMs).toISOString() };
  return {
    ready: true,
    nextClaimFence: group.currentClaimFence + 1,
    items: candidates,
  };
}

/**
 * Identity-fenced selective session continuation contract (`dec_E0CB793DAA21F49FF1E98D5067`).
 *
 * Provider session `--resume` inheritance is keyed by `(employeeId, taskId, dispatchLineage)`:
 * - Same employee + clean prior terminal + resumable provider session => `"continue"` (`--resume`).
 * - Employee identity changed => `"handoff"` (never inherit raw `providerSessionId`; require `HandoffPacketV1`).
 * - Unclean prior terminal (`cancelled` / `stalled` / `unreachable`), lineage mismatch, or non-resumable runtime => `"fresh"`.
 */

export type RuntimeContinuationMode = "continue" | "fresh" | "handoff";

export type PriorTerminalDispositionKind =
  | "awaiting_ruling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stalled"
  | "unreachable"
  | "none";

export interface SessionContinuationInput {
  readonly requestedAgentId: string | null;
  readonly previousAgentId: string | null;
  readonly taskId: string | null;
  readonly previousTaskId: string | null;
  readonly lineageMatches: boolean;
  readonly providerSessionId: string | null;
  readonly runtimeSupportsResume: boolean;
  readonly previousTerminalKind: PriorTerminalDispositionKind;
  readonly hasHandoffPacket: boolean;
}

export interface SessionContinuationDecision {
  readonly mode: RuntimeContinuationMode;
  readonly allowProviderResume: boolean;
  readonly blockedWithoutHandoff: boolean;
  readonly reason:
    | "same_employee_clean_continuation"
    | "employee_switched_with_handoff"
    | "employee_switched_requires_handoff_packet"
    | "lineage_mismatch"
    | "unclean_prior_terminal"
    | "provider_resume_unavailable";
}

/** Decide whether a continuation may reuse `--resume <providerSessionId>`, must cold-start, or requires handoff. */
export function resolveSessionContinuationMode(input: SessionContinuationInput): SessionContinuationDecision {
  if (input.requestedAgentId !== input.previousAgentId)
    return {
      mode: "handoff",
      allowProviderResume: false,
      blockedWithoutHandoff: !input.hasHandoffPacket,
      reason: input.hasHandoffPacket ? "employee_switched_with_handoff" : "employee_switched_requires_handoff_packet",
    };

  if (input.taskId !== input.previousTaskId || !input.lineageMatches)
    return {
      mode: "fresh",
      allowProviderResume: false,
      blockedWithoutHandoff: false,
      reason: "lineage_mismatch",
    };

  if (
    input.previousTerminalKind === "cancelled" ||
    input.previousTerminalKind === "stalled" ||
    input.previousTerminalKind === "unreachable"
  )
    return {
      mode: "fresh",
      allowProviderResume: false,
      blockedWithoutHandoff: false,
      reason: "unclean_prior_terminal",
    };

  if (!input.providerSessionId || !input.runtimeSupportsResume)
    return {
      mode: "fresh",
      allowProviderResume: false,
      blockedWithoutHandoff: false,
      reason: "provider_resume_unavailable",
    };

  return {
    mode: "continue",
    allowProviderResume: true,
    blockedWithoutHandoff: false,
    reason: "same_employee_clean_continuation",
  };
}
