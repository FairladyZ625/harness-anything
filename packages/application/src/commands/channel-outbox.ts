import { createHash } from "node:crypto";
import type {
  CanonicalEventStore,
  CanonicalWriteBundle,
  TaskProjection,
  WriteReceiptDraft,
} from "@harness-anything/kernel";
import {
  CHANNEL_OUTBOX_RETRY_LEASE_MS,
  channelInboxSource,
  channelPageLimit,
  formatChannelOutboxSourceRef as formatChannelOutboxRef,
  parseChannelOutboxSourceRef,
  type ChannelDeliveryReceipt,
  type ChannelDeliveryStatus,
  type ChannelKind,
  type ChannelOutboxMessage,
  type ParsedChannelOutboxRef,
} from "@harness-anything/kernel/internal/domain/channel-adapter.ts";
import {
  compilePeerRequestOpened,
  type PeerRequestInput,
} from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import {
  inboxQueueCursor,
  type InboxEventPayloads,
  type InboxItem,
} from "@harness-anything/kernel/internal/domain/inbox.ts";
import {
  compileInboxClaimedEvent,
  compileInboxCompletedEvent,
  compileInboxEnqueuedEvent,
  compileInboxFailedEvent,
} from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import type { CommandBinding } from "./command-ports.ts";
import { reject } from "./entity-action-write-helpers.ts";

export interface ChannelCommandCell {
  readonly input: { readonly repoId: string };
  readonly store: Pick<CanonicalEventStore, "readHead" | "append" | "readContentBlob">;
  readonly projection: Pick<TaskProjection, "readCut" | "readInbox" | "readPeerRequests" | "apply">;
  readonly now: () => string;
  readonly readResult: (
    opId: string,
    value: object,
    revision: number,
    worktreeVisible: boolean | null,
  ) => WriteReceiptDraft;
}

export interface ChannelOutboundDeliveryContext {
  readonly cell: ChannelCommandCell;
  readonly binding: CommandBinding;
  readonly outboxItem: InboxItem;
  readonly now: string;
  readonly opId: string;
  readonly allocateRevision: () => number;
}

export interface ChannelOutboundDispatchResult {
  readonly status: ChannelDeliveryStatus;
  readonly recipientInboxItemId?: string;
  readonly peerRequestId?: string;
  readonly reasonCode?: string;
  readonly retryAfterMs?: number;
}

export interface ChannelOutboundAdapter {
  readonly id: string;
  readonly channelKind: ChannelKind;
  matches(message: ChannelOutboxMessage): boolean;
  deliver(message: ChannelOutboxMessage, context: ChannelOutboundDeliveryContext): ChannelOutboundDispatchResult;
}

export type ChannelOutboundAdapterResolver = (message: ChannelOutboxMessage) => ChannelOutboundAdapter | undefined;

export function channelScopedDedupeKey(input: {
  readonly channelKind: ChannelKind;
  readonly direction: "inbound" | "outbound";
  readonly principalPersonId: string;
  readonly participantRef: string;
  readonly idempotencyKey: string;
}): string {
  return `channel:${input.channelKind}:${input.direction}:${input.principalPersonId}:${input.participantRef}:${input.idempotencyKey}`;
}

export function channelItemId(dedupeKey: string): string {
  return `ch_${createHash("sha256").update(dedupeKey).digest("hex").slice(0, 24)}`;
}

export function channelBodyContent(body: string | undefined): {
  readonly claim?: { readonly sha256: string; readonly size: number; readonly mediaType: string };
  readonly blob?: { readonly sha256: string; readonly size: number; readonly mediaType: string; readonly body: string };
} {
  if (body === undefined) return {};
  const bytes = Buffer.from(body, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    claim: { sha256, size: bytes.byteLength, mediaType: "text/plain" },
    blob: { sha256, size: bytes.byteLength, mediaType: "text/plain", body },
  };
}

export function formatChannelOutboxSourceRef(input: ParsedChannelOutboxRef): string {
  const ref = formatChannelOutboxRef(input);
  if (ref === null) reject("invalid_field", "Channel outbox routing metadata exceeds 256 characters.");
  return ref;
}

export function buildInboxEnqueueBundle(input: {
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: CommandBinding["actor"];
  readonly source: CommandBinding["source"];
  readonly occurredAt: string;
  readonly payload: InboxEventPayloads["inbox_item_enqueued"];
  readonly blobs?: CanonicalWriteBundle["blobs"];
}): CanonicalWriteBundle {
  const event = compileInboxEnqueuedEvent({
    eventId: `event-${input.opId}`,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: input.payload,
  });
  return {
    event,
    plan: canonicalEventWritePlan(event, "inbox", input.payload.inboxId),
    blobs: input.blobs ?? [],
  };
}

export function commitChannelBatch(cell: ChannelCommandCell, batch: readonly CanonicalWriteBundle[]): void {
  const final = batch[batch.length - 1]!;
  cell.store.append({ ...final, preceding: batch.slice(0, -1) });
  for (const item of batch) cell.projection.apply(item.event, item.plan);
}

export function verifyPersistedInboxItem(
  cell: ChannelCommandCell,
  inboxId: string,
  itemId: string,
  expectedDedupeKey: string,
): InboxItem {
  const read = cell.projection.readInbox({ by: "item", inboxId, itemId });
  const persisted = read.status === "ready" ? read.items[0] : undefined;
  if (!persisted || persisted.dedupeKey !== expectedDedupeKey) {
    reject("conflict", `Persisted inbox item ${itemId} could not be verified for dedupe key.`);
  }
  return persisted!;
}

function deliverToRecipientInbox(
  message: ChannelOutboxMessage,
  context: ChannelOutboundDeliveryContext,
  admission: "dispatchable" | "quarantined_external",
  consumerKind: "interactive_watch" | "quarantined_external",
): ChannelOutboundDispatchResult {
  const recipientInboxId = `person:${message.recipientRef}`;
  const recipientDedupeKey = channelScopedDedupeKey({
    channelKind: message.channelKind,
    direction: "inbound",
    principalPersonId: message.recipientRef,
    participantRef: message.principalPersonId,
    idempotencyKey: `outbox:${context.outboxItem.itemId}`,
  });
  const existing = context.cell.projection.readInbox({
    by: "dedupe",
    inboxId: recipientInboxId,
    dedupeKey: recipientDedupeKey,
  });
  if (existing.status === "ready" && existing.items.length > 0) {
    return { status: "delivered", recipientInboxItemId: existing.items[0]!.itemId };
  }
  const recipientItemId = channelItemId(recipientDedupeKey);
  const revision = context.allocateRevision();
  const bodyContent = channelBodyContent(message.body);
  const bundle = buildInboxEnqueueBundle({
    opId: `${context.opId}-deliver`,
    workspaceRevision: revision,
    actor: context.binding.actor,
    source: context.binding.source,
    occurredAt: context.now,
    payload: {
      inboxId: recipientInboxId,
      itemId: recipientItemId,
      source: channelInboxSource(message.channelKind),
      sourceRef: `channel:in:${message.channelKind}:${message.messageId}`,
      sourceEpoch: 1,
      dedupeKey: recipientDedupeKey,
      admission,
      consumerKind,
      taskId: null,
      agentId: null,
      senderPersonId: message.principalPersonId,
      workId: null,
      lane: null,
      correlationId: message.correlationId ?? message.messageId,
      minRevision: revision,
      ...(bodyContent.claim
        ? { requiredBlobSha256s: [bodyContent.claim.sha256], bodyContentClaim: bodyContent.claim }
        : { requiredBlobSha256s: [] }),
      summary: message.summary,
      enqueuedAt: context.now,
    },
    ...(bodyContent.blob ? { blobs: [bodyContent.blob] } : {}),
  });
  commitChannelBatch(context.cell, [bundle]);
  verifyPersistedInboxItem(context.cell, recipientInboxId, recipientItemId, recipientDedupeKey);
  return { status: "delivered", recipientInboxItemId: recipientItemId };
}

function deliverPeerOutbound(
  message: ChannelOutboxMessage,
  context: ChannelOutboundDeliveryContext,
): ChannelOutboundDispatchResult {
  const requestId = `ch_${createHash("sha256")
    .update(
      `${context.cell.input.repoId}:${message.principalPersonId}:${message.recipientRef}:${message.idempotencyKey}`,
    )
    .digest("hex")
    .slice(0, 24)}`;
  const existingPeer = context.cell.projection.readPeerRequests({ by: "id", requestId });
  if (existingPeer.status === "ready" && existingPeer.requests.length > 0) {
    return { status: "routed", peerRequestId: requestId, recipientInboxItemId: `peer-req-${requestId}` };
  }
  const requestInput: PeerRequestInput = {
    requestId,
    from: { personId: message.principalPersonId, nodeId: context.cell.input.repoId },
    to: { personId: message.recipientRef },
    kind: "question",
    summary: message.summary,
    structuredBody: {
      claim: message.body ?? message.summary,
      requestedAction: message.summary,
    },
    attachments: [],
  };
  const openedRevision = context.allocateRevision();
  const openEvent = compilePeerRequestOpened(
    {
      eventId: `event-${context.opId}-peer-open`,
      workspaceRevision: openedRevision,
      opId: `${context.opId}-peer-open`,
      actor: context.binding.actor,
      source: context.binding.source,
      occurredAt: context.now,
    },
    { requestRevision: 1, request: requestInput },
  );
  const recipientInboxId = `person:${message.recipientRef}`;
  const recipientItemId = `peer-req-${requestId}`;
  const recipientDedupeKey = channelScopedDedupeKey({
    channelKind: "a2a-peer",
    direction: "inbound",
    principalPersonId: message.recipientRef,
    participantRef: message.principalPersonId,
    idempotencyKey: `outbox:${context.outboxItem.itemId}`,
  });
  const inboxRevision = context.allocateRevision();
  const inboxBundle = buildInboxEnqueueBundle({
    opId: `${context.opId}-peer-inbox`,
    workspaceRevision: inboxRevision,
    actor: context.binding.actor,
    source: context.binding.source,
    occurredAt: context.now,
    payload: {
      inboxId: recipientInboxId,
      itemId: recipientItemId,
      source: "peer_request",
      sourceRef: requestId,
      sourceEpoch: 1,
      dedupeKey: recipientDedupeKey,
      admission: "dispatchable",
      consumerKind: "interactive_watch",
      taskId: null,
      agentId: null,
      senderPersonId: message.principalPersonId,
      workId: null,
      lane: null,
      correlationId: requestId,
      minRevision: inboxRevision,
      requiredBlobSha256s: [],
      summary: message.summary,
      enqueuedAt: context.now,
    },
  });
  commitChannelBatch(context.cell, [
    { event: openEvent, plan: canonicalEventWritePlan(openEvent, "peer-request", requestId), blobs: [] },
    inboxBundle,
  ]);
  return { status: "routed", peerRequestId: requestId, recipientInboxItemId: recipientItemId };
}

const BUILTIN_OUTBOUND_ADAPTERS: readonly ChannelOutboundAdapter[] = [
  {
    id: "builtin:gui",
    channelKind: "gui",
    matches: (message) => message.channelKind === "gui",
    deliver: (message, context) => deliverToRecipientInbox(message, context, "dispatchable", "interactive_watch"),
  },
  {
    id: "builtin:webhook-local-loopback",
    channelKind: "webhook",
    matches: (message) => message.channelKind === "webhook" && message.route === "local-loopback",
    deliver: (message, context) =>
      deliverToRecipientInbox(message, context, "quarantined_external", "quarantined_external"),
  },
  {
    id: "builtin:a2a-peer",
    channelKind: "a2a-peer",
    matches: (message) => message.channelKind === "a2a-peer",
    deliver: (message, context) => deliverPeerOutbound(message, context),
  },
];

export function resolveBuiltinChannelOutboundAdapter(
  message: ChannelOutboxMessage,
): ChannelOutboundAdapter | undefined {
  return BUILTIN_OUTBOUND_ADAPTERS.find(
    (adapter) => adapter.channelKind === message.channelKind && adapter.matches(message),
  );
}

function reconstructOutboxMessage(cell: ChannelCommandCell, item: InboxItem): ChannelOutboxMessage | null {
  const parsed = parseChannelOutboxSourceRef(item.sourceRef);
  if (!parsed) return null;
  const bodySha = item.requiredBlobSha256s[0];
  const rawBody = bodySha ? cell.store.readContentBlob(bodySha) : null;
  const body = rawBody ? Buffer.from(rawBody).toString("utf8") : undefined;
  const keyPrefix = `channel:${parsed.channelKind}:outbound:${item.senderPersonId ?? ""}:${parsed.recipientRef}:`;
  const idempotencyKey = item.dedupeKey.startsWith(keyPrefix) ? item.dedupeKey.slice(keyPrefix.length) : item.dedupeKey;
  return {
    messageId: parsed.messageId,
    channelKind: parsed.channelKind,
    idempotencyKey,
    principalPersonId: item.senderPersonId ?? item.inboxId.replace(/^person:/u, ""),
    summary: item.summary,
    ...(body !== undefined ? { body } : {}),
    recipientRef: parsed.recipientRef,
    ...(parsed.route ? { route: parsed.route } : {}),
    ...(item.correlationId ? { correlationId: item.correlationId } : {}),
  };
}

export interface ChannelOutboxDrainResult {
  readonly receipts: readonly ChannelDeliveryReceipt[];
  readonly nextCursor: string | null;
}

/**
 * G3 cursor consumer for durable Channel Outbox items: claims pending or lease-expired items in
 * `enqueuedRevision` order, dispatches each through its registered adapter, and records durable
 * completion, failure, or retryable claim state so restarts replay pending deliveries safely.
 */
export function drainChannelOutbox(
  cell: ChannelCommandCell,
  binding: CommandBinding,
  options: {
    readonly principalPersonId?: string;
    readonly targetItemId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly now?: string;
    readonly opIdPrefix?: string;
    readonly claimOpId?: string;
    readonly retryLeaseMs?: number;
    readonly resolveAdapter?: ChannelOutboundAdapterResolver;
  } = {},
): ChannelOutboxDrainResult {
  const personId = options.principalPersonId ?? binding.actor.principal.personId;
  const inboxId = `person:${personId}`;
  const now = options.now ?? cell.now();
  const nowMs = Date.parse(now);
  const limit = channelPageLimit(options.limit);
  const baseLeaseMs = options.retryLeaseMs ?? CHANNEL_OUTBOX_RETRY_LEASE_MS;
  const resolveAdapter = options.resolveAdapter ?? resolveBuiltinChannelOutboundAdapter;

  const candidates: InboxItem[] = [];
  let nextCursor: string | null = null;
  if (options.targetItemId) {
    const read = cell.projection.readInbox({ by: "item", inboxId, itemId: options.targetItemId });
    if (read.status === "ready") candidates.push(...read.items);
  } else {
    const pendingRead = cell.projection.readInbox({
      by: "queue",
      status: "pending",
      consumerKind: "interactive_watch",
      inboxId,
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
    const claimedRead = cell.projection.readInbox({
      by: "queue",
      status: "claimed",
      consumerKind: "interactive_watch",
      inboxId,
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
    if (pendingRead.status === "ready") candidates.push(...pendingRead.items);
    if (claimedRead.status === "ready") candidates.push(...claimedRead.items);
    candidates.sort((a, b) => a.enqueuedRevision - b.enqueuedRevision);
    if (pendingRead.status === "ready" && pendingRead.nextCursor !== null) nextCursor = pendingRead.nextCursor;
    else if (claimedRead.status === "ready" && claimedRead.nextCursor !== null) nextCursor = claimedRead.nextCursor;
  }

  let head = cell.store.readHead()?.revision ?? 0;
  const allocateRevision = () => {
    head += 1;
    return head;
  };

  const receipts: ChannelDeliveryReceipt[] = [];
  const minRev = options.cursor ? inboxQueueCursor(options.cursor) : 0;

  for (const item of candidates) {
    if (item.enqueuedRevision <= minRev) continue;
    if (item.status === "completed" || item.status === "failed" || item.status === "dropped_stale") continue;
    if (item.status === "claimed" && item.leaseUntil && Date.parse(item.leaseUntil) > nowMs) continue;
    const message = reconstructOutboxMessage(cell, item);
    if (!message) continue;
    const adapter = resolveAdapter(message);
    if (!adapter) continue;

    const attempt = item.claimCount + 1;
    const opBase = options.opIdPrefix ?? `outbox-${item.itemId}-a${attempt}`;
    const claimId = `claim_${item.itemId}_a${attempt}`;
    const leaseUntil = new Date(nowMs + baseLeaseMs).toISOString();
    const claimEvent = compileInboxClaimedEvent({
      eventId: `event-${opBase}-claim`,
      workspaceRevision: allocateRevision(),
      opId: options.claimOpId ?? `${opBase}-claim`,
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        inboxId,
        itemId: item.itemId,
        claimId,
        claimedAt: now,
        leaseUntil,
      },
    });
    commitChannelBatch(cell, [
      { event: claimEvent, plan: canonicalEventWritePlan(claimEvent, "inbox", inboxId), blobs: [] },
    ]);

    const dispatched = adapter.deliver(message, {
      cell,
      binding,
      outboxItem: item,
      now,
      opId: opBase,
      allocateRevision,
    });

    const bodySha = item.requiredBlobSha256s[0];
    if (dispatched.status === "delivered" || dispatched.status === "routed") {
      const completeEvent = compileInboxCompletedEvent({
        eventId: `event-${opBase}-complete`,
        workspaceRevision: allocateRevision(),
        opId: `${opBase}-complete`,
        actor: binding.actor,
        source: binding.source,
        occurredAt: now,
        payload: {
          inboxId,
          itemId: item.itemId,
          claimId,
          dispatchId: dispatched.recipientInboxItemId ?? dispatched.peerRequestId ?? item.itemId,
          completedAt: now,
        },
      });
      commitChannelBatch(cell, [
        { event: completeEvent, plan: canonicalEventWritePlan(completeEvent, "inbox", inboxId), blobs: [] },
      ]);
      receipts.push({
        receiptId: `rcpt_${message.messageId}`,
        envelopeId: message.messageId,
        channelKind: message.channelKind,
        direction: "outbound",
        idempotencyKey: message.idempotencyKey,
        status: dispatched.status,
        principalPersonId: message.principalPersonId,
        recipientRef: message.recipientRef,
        inboxItemId: dispatched.recipientInboxItemId ?? item.itemId,
        ...(dispatched.peerRequestId ? { peerRequestId: dispatched.peerRequestId } : {}),
        ...(bodySha ? { bodyBlobSha256: bodySha } : {}),
        deliveredAt: now,
      });
      continue;
    }

    if (dispatched.status === "failed") {
      const failEvent = compileInboxFailedEvent({
        eventId: `event-${opBase}-fail`,
        workspaceRevision: allocateRevision(),
        opId: `${opBase}-fail`,
        actor: binding.actor,
        source: binding.source,
        occurredAt: now,
        payload: {
          inboxId,
          itemId: item.itemId,
          claimId,
          reasonCode: dispatched.reasonCode ?? "adapter_delivery_failed",
          failedAt: now,
        },
      });
      commitChannelBatch(cell, [
        { event: failEvent, plan: canonicalEventWritePlan(failEvent, "inbox", inboxId), blobs: [] },
      ]);
      receipts.push({
        receiptId: `rcpt_${message.messageId}`,
        envelopeId: message.messageId,
        channelKind: message.channelKind,
        direction: "outbound",
        idempotencyKey: message.idempotencyKey,
        status: "failed",
        principalPersonId: message.principalPersonId,
        recipientRef: message.recipientRef,
        inboxItemId: item.itemId,
        ...(bodySha ? { bodyBlobSha256: bodySha } : {}),
        reasonCode: dispatched.reasonCode ?? "adapter_delivery_failed",
        deliveredAt: now,
      });
      continue;
    }

    // Transient failure: item remains durably claimed until lease expiry, then replays on drain/restart.
    receipts.push({
      receiptId: `rcpt_${message.messageId}`,
      envelopeId: message.messageId,
      channelKind: message.channelKind,
      direction: "outbound",
      idempotencyKey: message.idempotencyKey,
      status: "pending_retry",
      principalPersonId: message.principalPersonId,
      recipientRef: message.recipientRef,
      inboxItemId: item.itemId,
      ...(bodySha ? { bodyBlobSha256: bodySha } : {}),
      reasonCode: dispatched.reasonCode ?? "adapter_delivery_retry",
      deliveredAt: now,
    });
  }

  return { receipts, nextCursor };
}
