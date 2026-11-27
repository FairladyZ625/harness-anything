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
import type { OntologyJudgmentDeclaration, OntologyPolicyDeclaration } from "./ontology-source.ts";
import { timestamp } from "./timestamp.ts";
import { isNonEmptyString, isRecord } from "./write-chain.contract.ts";

export const INBOX_MODEL_VERSION = 3;
export const INBOX_PAGE_LIMIT = 200;
const INBOX_TEXT_LIMIT = 256;
export const INBOX_SUMMARY_LIMIT = 1024;

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
/** Non-terminal statuses; each one is an ordered queue within one consumer kind. */
export const inboxQueueStatuses = ["pending", "quarantined_external", "claimed"] as const;
export type InboxQueueStatus = (typeof inboxQueueStatuses)[number];

export const inboxItemSources = [
  "ruling_resolved",
  "timer_fired",
  "task_stalled",
  "channel_message",
  "external_ingress",
  "peer_request",
  "peer_reply",
  // Expand-Contract Step 1 / Reader-First (dec_659E15CF, dec_A7A88E2079CA1DE548234A6CC3):
  // admit decoding/replay/projection before PR 1B enables production writers.
  "runtime_steer",
  "runtime_report",
] as const;
export type InboxItemSource = (typeof inboxItemSources)[number];
/** External input lands quarantined until host isolation (CH4) exists; it never wakes a runtime. */
export const inboxItemAdmissions = ["dispatchable", "quarantined_external"] as const;
export type InboxItemAdmission = (typeof inboxItemAdmissions)[number];
/** Which single consumer class may claim an item; this is separate from external-input admission. */
export const inboxConsumerKinds = ["unattended_dispatch", "interactive_watch", "quarantined_external"] as const;
export type InboxConsumerKind = (typeof inboxConsumerKinds)[number];
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
    readonly consumerKind?: InboxConsumerKind;
    readonly taskId: string | null;
    readonly agentId: string | null;
    readonly senderPersonId?: string | null;
    readonly workId?: string | null;
    readonly lane?: string | null;
    readonly correlationId?: string | null;
    readonly minRevision?: number;
    readonly requiredBlobSha256s?: readonly string[];
    readonly bodyContentClaim?: {
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: string;
    };
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

/** Optional additions keep already accepted Inbox event envelopes readable. */
export const inboxOptionalPayloadFields: Partial<Record<InboxEventType, readonly string[]>> = {
  inbox_item_enqueued: [
    "senderPersonId",
    "consumerKind",
    "workId",
    "lane",
    "correlationId",
    "minRevision",
    "requiredBlobSha256s",
    "bodyContentClaim",
  ],
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
  readonly senderPersonId: string | null;
  readonly workId: string | null;
  readonly lane: string | null;
  readonly correlationId: string | null;
  readonly minRevision: number;
  readonly requiredBlobSha256s: readonly string[];
  readonly consumerKind: InboxConsumerKind;
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
        senderPersonId: event.actor.principal?.personId ?? null,
        workId: payload.workId ?? null,
        lane: payload.lane ?? null,
        correlationId: payload.correlationId ?? null,
        minRevision: payload.minRevision ?? event.workspaceRevision,
        requiredBlobSha256s: payload.requiredBlobSha256s ?? [],
        consumerKind:
          payload.consumerKind ??
          (payload.admission === "quarantined_external" ? "quarantined_external" : "unattended_dispatch"),
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

interface InboxQueueReadOptions {
  readonly by: "queue";
  readonly status: InboxQueueStatus;
  readonly limit?: number;
  /** The `enqueuedRevision` of the last item on the previous page. */
  readonly cursor?: string;
}

export type InboxQueueQuery =
  | (InboxQueueReadOptions & {
      readonly consumerKind: "interactive_watch";
      /** Interactive watch reads are explicitly targeted to one recipient Inbox. */
      readonly inboxId: string;
    })
  | (InboxQueueReadOptions & {
      readonly consumerKind: "unattended_dispatch" | "quarantined_external";
      /** Omitted: the cross-inbox queue for this consumer kind. */
      readonly inboxId?: string;
    });

export type InboxQuery =
  | { readonly by: "item"; readonly inboxId: string; readonly itemId: string }
  | { readonly by: "dedupe"; readonly inboxId: string; readonly dedupeKey: string }
  | { readonly by: "inbox"; readonly inboxId: string; readonly limit?: number; readonly cursor?: string }
  | { readonly by: "inbox-updates"; readonly inboxId: string; readonly afterRevision: number; readonly limit?: number }
  | InboxQueueQuery;

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

/** `task:<taskId>`, `agent:<agentId>`, `person:<personId>`, or `supervisor:<workId|repo>`. */
export function isValidInboxId(value: unknown): value is string {
  return typeof value === "string" && /^(?:task|agent|person|supervisor):[^\s]{1,128}$/u.test(value);
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
    (value.consumerKind !== undefined && !(inboxConsumerKinds as readonly unknown[]).includes(value.consumerKind)) ||
    !nullableText(value.taskId) ||
    !nullableText(value.agentId) ||
    (value.senderPersonId !== undefined && !nullableText(value.senderPersonId)) ||
    (value.workId !== undefined && !nullableText(value.workId)) ||
    (value.lane !== undefined && !nullableText(value.lane)) ||
    (value.correlationId !== undefined && !nullableText(value.correlationId)) ||
    (value.minRevision !== undefined && !epoch(value.minRevision)) ||
    (value.requiredBlobSha256s !== undefined &&
      (!Array.isArray(value.requiredBlobSha256s) ||
        value.requiredBlobSha256s.length > 16 ||
        !value.requiredBlobSha256s.every((sha) => typeof sha === "string" && /^[a-f0-9]{64}$/u.test(sha)))) ||
    (value.bodyContentClaim !== undefined &&
      (!isRecord(value.bodyContentClaim) ||
        Object.keys(value.bodyContentClaim).some((field) => !["sha256", "size", "mediaType"].includes(field)) ||
        typeof value.bodyContentClaim.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.bodyContentClaim.sha256) ||
        !epoch(value.bodyContentClaim.size) ||
        !boundedText(value.bodyContentClaim.mediaType, 128) ||
        !Array.isArray(value.requiredBlobSha256s) ||
        !value.requiredBlobSha256s.includes(value.bodyContentClaim.sha256))) ||
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
  const externalIngress = value.source === "external_ingress",
    channelMessage = value.source === "channel_message",
    consumerKind =
      value.consumerKind ??
      (value.admission === "quarantined_external" ? "quarantined_external" : "unattended_dispatch");
  if (
    externalIngress !== (value.admission === "quarantined_external") ||
    externalIngress !== (consumerKind === "quarantined_external") ||
    (channelMessage &&
      (value.admission !== "dispatchable" ||
        value.consumerKind !== "interactive_watch" ||
        !String(value.inboxId).startsWith("person:"))) ||
    ((value.source === "peer_request" || value.source === "peer_reply") &&
      (value.consumerKind === undefined || value.consumerKind !== "interactive_watch")) ||
    (value.source === "runtime_steer" &&
      (value.admission !== "dispatchable" || !String(value.inboxId).startsWith("task:"))) ||
    (value.source === "runtime_report" &&
      (value.admission !== "dispatchable" ||
        (!String(value.inboxId).startsWith("task:") && !String(value.inboxId).startsWith("person:"))))
  )
    return ["external ingress must be quarantined, and peer messages must use the interactive watch consumer"];
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

/** Inbox aggregate declarations (dec_7CE3162BF9BFB157DAB9F9B6C0 CH1, R4). */
const inboxFixtures = [
  "packages/kernel/test/inbox.test.ts",
  "packages/storage/test/store/inbox-projection.test.ts",
  "packages/storage/test/pglite/pglite-inbox.integration.test.ts",
  "packages/storage/test/postgres/pg-inbox.integration.test.ts",
];
const inboxSource = (symbol: string) => `policy:packages/kernel:packages/kernel/src/domain/inbox.ts#${symbol}`;

export const inboxPolicies = [
  {
    id: "inbox-queue-page",
    ownerRef: "runtime-session/inbox_item_enqueued",
    unit: "inbox items per read",
    bounds:
      "Consumer-partition reads require consumerKind unattended_dispatch, interactive_watch, or quarantined_external, return at most 200 items in enqueue-revision order, and keep each consumer isolated; identities are at most 256 characters, dedupe keys 512 and summaries 1024.",
    defaultValue: INBOX_PAGE_LIMIT,
    version: 2,
    scope: "Inbox events and Inbox projection reads",
    reason:
      "Bound every Inbox read and payload so one fold and one page never grow with inbox history, and keep background dispatch from claiming interactive watch messages.",
    fixtures: inboxFixtures,
    sources: [
      inboxSource("INBOX_PAGE_LIMIT:7fbdd7a0b52227f85420ba40b43bb354"),
      inboxSource("INBOX_TEXT_LIMIT:eb151f03d98158007b488536b00f7417"),
      inboxSource("INBOX_SUMMARY_LIMIT:e6e6093fc4dce229ecd75abcef9891e3"),
      inboxSource("enqueuedIssues:b52c34440b99f9ecbadad1ba19b4a5a1"),
      inboxSource("reduceInboxItem.item.consumerKind:19b8d7be33270534fffa4e6841d73c43"),
    ].map((candidateId) => ({ candidateId, route: "readInbox" })),
  },
  {
    id: "inbox-claim-lease",
    ownerRef: "runtime-session/inbox_item_claimed",
    unit: "claim lease",
    bounds:
      "An unexpired claim blocks another claim and automatic consumption; an expired claim may be re-claimed (claimCount starts at 0 and counts every claim). Settlement requires the live claim id.",
    defaultValue: null,
    version: 1,
    scope: "Inbox item reducer and consumption verdict",
    reason: "One consumer holds a wakeup at a time; a crashed consumer's lease expires instead of blocking forever.",
    fixtures: inboxFixtures,
    sources: [
      inboxSource("reduceInboxItem:77e178908aaf962825288d58ba8df969"),
      inboxSource("reduceInboxItem.item.claimCount:416281315eda57adb7f05a07e5976b64"),
      inboxSource("evaluateInboxConsumption:d7103da7b4f4aa77083daa89e73ec24c"),
      "policy:packages/kernel:packages/kernel/src/domain/status-word-register-inbox.ts#meanings.claimed:c14d85c9256f3d7f11fd3e8f74a785c5",
    ].map((candidateId) => ({ candidateId, route: "readInbox" })),
  },
  {
    id: "inbox-external-quarantine",
    ownerRef: "runtime-session/inbox_item_enqueued",
    unit: "inbox admission",
    bounds:
      "external_ingress is admitted only as quarantined_external and only into the quarantined_external consumerKind; channel_message is dispatchable only for a person: inbox with the interactive_watch consumerKind; peer_request and peer_reply require interactive_watch; runtime_steer is dispatchable only for a task: inbox; runtime_report is dispatchable only for a task: or person: inbox.",
    defaultValue: "quarantined_external",
    version: 2,
    scope: "Inbox events until verified host isolation exists (R4)",
    reason: "External input is recorded but never executed before host isolation exists.",
    fixtures: inboxFixtures,
    sources: [
      inboxSource("reduceInboxItem.item.status:d91a350dc6eb2c6f420694fcd95c75f1"),
      inboxSource("enqueuedIssues:1fea5df76694395d7b799c3b236d1508"),
      inboxSource("enqueuedIssues.consumerKind:610cfd0bf7fd352a34dc7f040d91a4c1"),
      inboxSource("enqueuedIssues:a5d8d2a31bd53b9d3d3e45e6271f082f"),
    ].map((candidateId) => ({ candidateId, route: "readInbox" })),
  },
] as const satisfies readonly OntologyPolicyDeclaration[];

export const inboxJudgments = [
  {
    id: "inbox-event-payload",
    symbol: "packages/kernel/src/domain/inbox.ts#validateInboxEventPayload",
    inputs: ["InboxEventType", "unknown payload"],
    output: "readonly string[] issues",
    failureCodes: [],
    explain:
      "Field-value contract of the Inbox event payloads, including peer traffic and optional causal-routing metadata, called once from the agent runtime event validator.",
    consumers: ["packages/kernel/src/domain/agent-runtime.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/inbox.ts#validateInboxEventPayload:6784994f2fb7b2a63475471070ae296e",
        route: "validateInboxEventPayload",
      },
    ],
  },
  {
    id: "session-continuation-fence",
    symbol: "packages/kernel/src/domain/runtime-session-continuation.ts#assertSessionContinuationFence",
    inputs: ["SessionContinuationFenceInput"],
    output: "SessionContinuationFenceVerdict",
    failureCodes: ["unattended_prior_stop_unproven", "unattended_handoff_packet_missing"],
    explain:
      "Govern only unattended wakeups: refuse without stop proof or handoff, cold-start instead of resuming an unclean session; operator recovery and provider-fallback are not governed.",
    consumers: [],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/runtime-session-continuation.ts#assertSessionContinuationFence:11a4e74bbffe81664d8e0e4e41629894",
        route: "assertSessionContinuationFence",
      },
    ],
  },
  {
    id: "unattended-launch-admission",
    symbol: "packages/kernel/src/domain/unattended-launch-admission.ts#assertUnattendedLaunchAdmission",
    inputs: ["UnattendedLaunchAdmissionInput"],
    output: "UnattendedLaunchAdmission",
    failureCodes: [
      "unattended_permission_bypass_forbidden",
      "unattended_permission_exceeds_ceiling",
      "unattended_permission_unsupported",
    ],
    explain:
      "Refuse bypass, cap code work at workspace-write and supervision or peer-read-only work at read-only, fail closed on unsupported modes, and strip plaintext GitHub tokens.",
    consumers: [],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/unattended-launch-admission.ts#assertUnattendedLaunchAdmission:8e948bc6bfb0303cfd796198f8fdbdb1",
        route: "assertUnattendedLaunchAdmission",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];
