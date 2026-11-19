/**
 * Canonical Inbox aggregate (dec_7CE3162BF9BFB157DAB9F9B6C0 CH1, workspaceRevision 281198).
 *
 * One Inbox item is one aggregate row keyed by `(inboxId, itemId)` and unique by `(inboxId, dedupeKey)`.
 * Every backend projection (SQLite increment and rebuild, PGlite, PostgreSQL) folds the same five
 * `agent-runtime-event/v1` events through {@link reduceInboxItem}, so the fold cost of one event is
 * bounded by one item and never by the inbox's history. `inbox_item_enqueued` is an ordinary canonical
 * event: a source command appends it in the same publication as its source event (`preceding`), so a
 * crash cannot separate the source state from its wakeup intent.
 */
import type { AgentRuntimeEventV1 } from "./agent-runtime.ts";
import { timestamp } from "./timestamp.ts";
import { isNonEmptyString, isRecord } from "./write-chain.contract.ts";

export const INBOX_MODEL_VERSION = 1;
export const INBOX_PAGE_LIMIT = 200;
const INBOX_TEXT_LIMIT = 256;
const INBOX_SUMMARY_LIMIT = 1024;

export const inboxEventTypes = [
  "inbox_item_enqueued",
  "inbox_item_claimed",
  "inbox_item_completed",
  "inbox_item_failed",
  "inbox_item_dropped_stale",
] as const;
export type InboxEventType = (typeof inboxEventTypes)[number];

export const inboxItemStatuses = [
  "pending",
  "quarantined_external",
  "claimed",
  "completed",
  "failed",
  "dropped_stale",
] as const;
export type InboxItemStatus = (typeof inboxItemStatuses)[number];
/** Non-terminal statuses; each one is an ordered queue readable through {@link InboxQuery}. */
export const inboxQueueStatuses = ["pending", "quarantined_external", "claimed"] as const;
export type InboxQueueStatus = (typeof inboxQueueStatuses)[number];

export const inboxItemSources = ["ruling_resolved", "timer_fired", "task_stalled", "external_ingress"] as const;
export type InboxItemSource = (typeof inboxItemSources)[number];
/** External input lands quarantined until host isolation (CH4) exists; it never wakes a runtime. */
export const inboxItemAdmissions = ["dispatchable", "quarantined_external"] as const;
export type InboxItemAdmission = (typeof inboxItemAdmissions)[number];
export const inboxStaleReasons = ["source_epoch_superseded", "source_retired", "target_terminal"] as const;
export type InboxStaleReason = (typeof inboxStaleReasons)[number];

export interface InboxEventPayloads {
  readonly inbox_item_enqueued: {
    readonly inboxId: string;
    readonly itemId: string;
    readonly source: InboxItemSource;
    readonly sourceRef: string;
    readonly sourceEpoch: number;
    readonly dedupeKey: string;
    readonly admission: InboxItemAdmission;
    readonly taskId: string | null;
    readonly agentId: string | null;
    readonly summary: string;
    readonly enqueuedAt: string;
  };
  readonly inbox_item_claimed: {
    readonly inboxId: string;
    readonly itemId: string;
    readonly claimId: string;
    readonly claimedAt: string;
    readonly leaseUntil: string;
  };
  readonly inbox_item_completed: {
    readonly inboxId: string;
    readonly itemId: string;
    readonly claimId: string;
    readonly dispatchId: string | null;
    readonly completedAt: string;
  };
  readonly inbox_item_failed: {
    readonly inboxId: string;
    readonly itemId: string;
    readonly claimId: string;
    readonly reasonCode: string;
    readonly failedAt: string;
  };
  readonly inbox_item_dropped_stale: {
    readonly inboxId: string;
    readonly itemId: string;
    readonly claimId: string | null;
    readonly reasonCode: InboxStaleReason;
    readonly observedSourceEpoch: number | null;
    readonly droppedAt: string;
  };
}

export const inboxPayloadFields: { readonly [Type in InboxEventType]: readonly (keyof InboxEventPayloads[Type])[] } = {
  inbox_item_enqueued: [
    "inboxId",
    "itemId",
    "source",
    "sourceRef",
    "sourceEpoch",
    "dedupeKey",
    "admission",
    "taskId",
    "agentId",
    "summary",
    "enqueuedAt",
  ],
  inbox_item_claimed: ["inboxId", "itemId", "claimId", "claimedAt", "leaseUntil"],
  inbox_item_completed: ["inboxId", "itemId", "claimId", "dispatchId", "completedAt"],
  inbox_item_failed: ["inboxId", "itemId", "claimId", "reasonCode", "failedAt"],
  inbox_item_dropped_stale: ["inboxId", "itemId", "claimId", "reasonCode", "observedSourceEpoch", "droppedAt"],
};

export type InboxEvent = Extract<AgentRuntimeEventV1, { readonly type: InboxEventType }>;

export function isInboxEventType(type: string): type is InboxEventType {
  return (inboxEventTypes as readonly string[]).includes(type);
}

export function isInboxEvent(event: { readonly schema: string; readonly type: string }): event is InboxEvent {
  return event.schema === "agent-runtime-event/v1" && isInboxEventType(event.type);
}

export interface InboxItem {
  readonly inboxId: string;
  readonly itemId: string;
  readonly source: InboxItemSource;
  readonly sourceRef: string;
  readonly sourceEpoch: number;
  readonly dedupeKey: string;
  readonly taskId: string | null;
  readonly agentId: string | null;
  readonly summary: string;
  readonly status: InboxItemStatus;
  readonly enqueuedAt: string;
  /** Workspace revision of the accepted enqueue event: the queue order and the page cursor. */
  readonly enqueuedRevision: number;
  readonly claimId: string | null;
  readonly claimCount: number;
  readonly claimedAt: string | null;
  readonly leaseUntil: string | null;
  readonly settledAt: string | null;
  readonly settlementReason: string | null;
  readonly completedByDispatchId: string | null;
  readonly observedSourceEpoch: number | null;
  readonly revision: number;
}

export type InboxIgnoredReason =
  | "duplicate_dedupe_key"
  | "duplicate_item_id"
  | "item_missing"
  | "item_terminal"
  | "item_quarantined"
  | "claim_active"
  | "claim_mismatch"
  | "item_not_claimed";

export type InboxStep =
  | { readonly kind: "applied"; readonly item: InboxItem }
  | { readonly kind: "ignored"; readonly reason: InboxIgnoredReason };

/**
 * The read set a projection supplies to {@link reduceInboxItem}: for an enqueue, the item in the same
 * inbox that already holds the item id or the dedupe key; otherwise the item itself.
 */
export function inboxItemLookup(event: InboxEvent): {
  readonly inboxId: string;
  readonly itemId: string;
  readonly dedupeKey: string | null;
} {
  return {
    inboxId: event.payload.inboxId,
    itemId: event.payload.itemId,
    dedupeKey: event.type === "inbox_item_enqueued" ? event.payload.dedupeKey : null,
  };
}

export function isTerminalInboxStatus(status: InboxItemStatus): boolean {
  return status === "completed" || status === "failed" || status === "dropped_stale";
}

/** Deterministically fold one accepted Inbox event into the addressed item. */
export function reduceInboxItem(current: InboxItem | null, event: InboxEvent): InboxStep {
  if (event.type === "inbox_item_enqueued") {
    const payload = event.payload;
    if (current !== null)
      return {
        kind: "ignored",
        reason: current.itemId === payload.itemId ? "duplicate_item_id" : "duplicate_dedupe_key",
      };
    return {
      kind: "applied",
      item: {
        inboxId: payload.inboxId,
        itemId: payload.itemId,
        source: payload.source,
        sourceRef: payload.sourceRef,
        sourceEpoch: payload.sourceEpoch,
        dedupeKey: payload.dedupeKey,
        taskId: payload.taskId,
        agentId: payload.agentId,
        summary: payload.summary,
        status: payload.admission === "quarantined_external" ? "quarantined_external" : "pending",
        enqueuedAt: payload.enqueuedAt,
        enqueuedRevision: event.workspaceRevision,
        claimId: null,
        claimCount: 0,
        claimedAt: null,
        leaseUntil: null,
        settledAt: null,
        settlementReason: null,
        completedByDispatchId: null,
        observedSourceEpoch: null,
        revision: event.workspaceRevision,
      },
    };
  }
  if (current === null || current.inboxId !== event.payload.inboxId || current.itemId !== event.payload.itemId)
    return { kind: "ignored", reason: "item_missing" };
  if (isTerminalInboxStatus(current.status)) return { kind: "ignored", reason: "item_terminal" };
  const revision = Math.max(current.revision, event.workspaceRevision);

  if (event.type === "inbox_item_claimed") {
    const payload = event.payload;
    if (current.status === "quarantined_external") return { kind: "ignored", reason: "item_quarantined" };
    if (current.status === "claimed" && Date.parse(payload.claimedAt) < Date.parse(current.leaseUntil!))
      return { kind: "ignored", reason: "claim_active" };
    return {
      kind: "applied",
      item: {
        ...current,
        status: "claimed",
        claimId: payload.claimId,
        claimCount: current.claimCount + 1,
        claimedAt: payload.claimedAt,
        leaseUntil: payload.leaseUntil,
        revision,
      },
    };
  }

  if (event.type === "inbox_item_dropped_stale") {
    const payload = event.payload,
      claimMatches = current.status === "claimed" ? payload.claimId === current.claimId : payload.claimId === null;
    if (!claimMatches) return { kind: "ignored", reason: "claim_mismatch" };
    return {
      kind: "applied",
      item: {
        ...current,
        status: "dropped_stale",
        leaseUntil: null,
        settledAt: payload.droppedAt,
        settlementReason: payload.reasonCode,
        observedSourceEpoch: payload.observedSourceEpoch,
        revision,
      },
    };
  }

  if (current.status !== "claimed") return { kind: "ignored", reason: "item_not_claimed" };
  if (event.payload.claimId !== current.claimId) return { kind: "ignored", reason: "claim_mismatch" };
  if (event.type === "inbox_item_completed")
    return {
      kind: "applied",
      item: {
        ...current,
        status: "completed",
        leaseUntil: null,
        settledAt: event.payload.completedAt,
        completedByDispatchId: event.payload.dispatchId,
        revision,
      },
    };
  return {
    kind: "applied",
    item: {
      ...current,
      status: "failed",
      leaseUntil: null,
      settledAt: event.payload.failedAt,
      settlementReason: event.payload.reasonCode,
      revision,
    },
  };
}

/** Deterministic dedupe identity for one source occurrence: one wakeup per `(source, sourceRef, sourceEpoch)`. */
export function inboxDedupeKey(input: {
  readonly source: InboxItemSource;
  readonly sourceRef: string;
  readonly sourceEpoch: number;
}): string {
  return `${input.source}:${input.sourceRef}@${input.sourceEpoch}`;
}

/** What the single automatic consumer (InboxDispatcher) observed about an item's source and target. */
export interface InboxSourceObservation {
  /** Current epoch of the source (ruling lineage, lease generation, schedule round); null when retired. */
  readonly currentSourceEpoch: number | null;
  /** The target task or run is done/cancelled, so waking it would revive a stale scene. */
  readonly targetTerminal: boolean;
}

export type InboxConsumptionVerdict =
  | { readonly kind: "settled" }
  | { readonly kind: "claim" }
  | {
      readonly kind: "drop_stale";
      readonly reasonCode: InboxStaleReason;
      readonly observedSourceEpoch: number | null;
      readonly claimId: string | null;
    }
  | {
      readonly kind: "wait";
      readonly reason: "claim_active" | "quarantined" | "source_epoch_ahead";
      readonly wakeAt: string | null;
    };

/**
 * The consumption judgment for one item: an unexpired claim is left alone, a stale source is dropped with
 * an auditable `inbox_item_dropped_stale`, quarantined external input never wakes a runtime.
 */
export function evaluateInboxConsumption(
  item: InboxItem,
  observation: InboxSourceObservation,
  now: string,
): InboxConsumptionVerdict {
  if (isTerminalInboxStatus(item.status)) return { kind: "settled" };
  if (item.status === "claimed" && Date.parse(now) < Date.parse(item.leaseUntil!))
    return { kind: "wait", reason: "claim_active", wakeAt: item.leaseUntil };
  const claimId = item.status === "claimed" ? item.claimId : null,
    stale = (reasonCode: InboxStaleReason) =>
      ({ kind: "drop_stale", reasonCode, observedSourceEpoch: observation.currentSourceEpoch, claimId }) as const;
  if (observation.targetTerminal) return stale("target_terminal");
  if (observation.currentSourceEpoch === null) return stale("source_retired");
  if (observation.currentSourceEpoch > item.sourceEpoch) return stale("source_epoch_superseded");
  if (observation.currentSourceEpoch < item.sourceEpoch)
    return { kind: "wait", reason: "source_epoch_ahead", wakeAt: null };
  if (item.status === "quarantined_external") return { kind: "wait", reason: "quarantined", wakeAt: null };
  return { kind: "claim" };
}

export type InboxQuery =
  | { readonly by: "item"; readonly inboxId: string; readonly itemId: string }
  | { readonly by: "dedupe"; readonly inboxId: string; readonly dedupeKey: string }
  | {
      readonly by: "queue";
      readonly status: InboxQueueStatus;
      /** Omitted: the cross-inbox queue in enqueue order, which the single consumer pages through. */
      readonly inboxId?: string;
      readonly limit?: number;
      /** The `enqueuedRevision` of the last item on the previous page. */
      readonly cursor?: string;
    };

export type InboxRead =
  | { readonly status: "pending"; readonly watermark: number; readonly sourceRevision: number }
  | {
      readonly status: "ready";
      readonly watermark: number;
      readonly sourceRevision: number;
      readonly items: readonly InboxItem[];
      readonly nextCursor: string | null;
    };

export function inboxPageLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, Math.trunc(limit ?? INBOX_PAGE_LIMIT)), INBOX_PAGE_LIMIT);
}

/** Parse a queue cursor; malformed cursors fail closed instead of silently restarting the queue. */
export function inboxQueueCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(cursor)) throw new Error(`inbox queue cursor is invalid: ${cursor}`);
  return Number(cursor);
}

export function inboxQueueNextCursor(items: readonly InboxItem[], limit: number): string | null {
  return items.length > limit ? String(items[limit - 1]!.enqueuedRevision) : null;
}

function boundedText(value: unknown, limit = INBOX_TEXT_LIMIT): boolean {
  return isNonEmptyString(value) && value.length <= limit && value.trim() === value;
}

function nullableText(value: unknown): boolean {
  return value === null || boundedText(value);
}

function epoch(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** `task:<taskId>`, `agent:<agentId>`, or `supervisor:<workId|repo>` (CH2 supervisor inbox). */
export function isValidInboxId(value: unknown): value is string {
  return typeof value === "string" && /^(?:task|agent|supervisor):[^\s]{1,128}$/u.test(value);
}

function enqueuedIssues(value: Readonly<Record<string, unknown>>): readonly string[] {
  if (
    !isValidInboxId(value.inboxId) ||
    !boundedText(value.itemId) ||
    !(inboxItemSources as readonly unknown[]).includes(value.source) ||
    !boundedText(value.sourceRef) ||
    !epoch(value.sourceEpoch) ||
    !boundedText(value.dedupeKey, 512) ||
    !(inboxItemAdmissions as readonly unknown[]).includes(value.admission) ||
    !nullableText(value.taskId) ||
    !nullableText(value.agentId) ||
    !boundedText(value.summary, INBOX_SUMMARY_LIMIT) ||
    !timestamp(String(value.enqueuedAt))
  )
    return ["inbox item enqueue payload is invalid"];
  const inboxId = String(value.inboxId),
    separator = inboxId.indexOf(":"),
    kind = inboxId.slice(0, separator),
    id = inboxId.slice(separator + 1);
  if ((kind === "task" && value.taskId !== id) || (kind === "agent" && value.agentId !== id))
    return ["inbox item enqueue target does not match its inbox"];
  // R4 hard gate: until verified host isolation exists, external input is recorded, never executed.
  if ((value.source === "external_ingress") !== (value.admission === "quarantined_external"))
    return ["inbox external ingress must be quarantined, and only external ingress may be quarantined"];
  return [];
}

function claimedIssues(value: Readonly<Record<string, unknown>>): readonly string[] {
  return isValidInboxId(value.inboxId) &&
    boundedText(value.itemId) &&
    boundedText(value.claimId) &&
    timestamp(String(value.claimedAt)) &&
    timestamp(String(value.leaseUntil)) &&
    Date.parse(String(value.leaseUntil)) > Date.parse(String(value.claimedAt))
    ? []
    : ["inbox item claim payload is invalid"];
}

function settledIssues(type: "inbox_item_completed" | "inbox_item_failed", value: Readonly<Record<string, unknown>>) {
  const common = isValidInboxId(value.inboxId) && boundedText(value.itemId) && boundedText(value.claimId);
  if (type === "inbox_item_completed")
    return common && nullableText(value.dispatchId) && timestamp(String(value.completedAt))
      ? []
      : ["inbox item completion payload is invalid"];
  return common && boundedText(value.reasonCode) && timestamp(String(value.failedAt))
    ? []
    : ["inbox item failure payload is invalid"];
}

function droppedIssues(value: Readonly<Record<string, unknown>>): readonly string[] {
  return isValidInboxId(value.inboxId) &&
    boundedText(value.itemId) &&
    nullableText(value.claimId) &&
    (inboxStaleReasons as readonly unknown[]).includes(value.reasonCode) &&
    (value.observedSourceEpoch === null || epoch(value.observedSourceEpoch)) &&
    timestamp(String(value.droppedAt))
    ? []
    : ["inbox item stale drop payload is invalid"];
}

/** Field-value contract of the five Inbox payloads; field presence is checked by the runtime envelope. */
export function validateInboxEventPayload(type: InboxEventType, value: unknown): readonly string[] {
  if (!isRecord(value)) return ["inbox payload must be an object"];
  if (type === "inbox_item_enqueued") return enqueuedIssues(value);
  if (type === "inbox_item_claimed") return claimedIssues(value);
  if (type === "inbox_item_dropped_stale") return droppedIssues(value);
  return settledIssues(type, value);
}
