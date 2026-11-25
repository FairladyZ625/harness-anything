import { createHash, randomBytes } from "node:crypto";
import type { WriteReceiptDraft } from "@harness-anything/kernel";
import {
  CHANNEL_LIST_SCAN_BATCHES,
  channelDirections,
  channelInboxSource,
  channelKinds,
  channelPageLimit,
  validateChannelInboxEnvelope,
  validateChannelOutboxMessage,
  type ChannelDeliveryReceipt,
  type ChannelDirection,
  type ChannelKind,
  type ChannelListItem,
  type ChannelOutboxMessage,
} from "@harness-anything/kernel/internal/domain/channel-adapter.ts";
import {
  compilePeerRequestOpened,
  reducePeerRequestEvent,
  verifyPeerSenderIdentity,
  type PeerRequestInput,
  type PeerRequestV1,
} from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { inboxQueueCursor, type InboxItem } from "@harness-anything/kernel/internal/domain/inbox.ts";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { reject } from "@harness-anything/application/internal/commands/entity-action-write-helpers.ts";
import {
  buildInboxEnqueueBundle,
  channelBodyContent,
  channelItemId,
  channelScopedDedupeKey,
  commitChannelBatch,
  drainChannelOutbox,
  formatChannelOutboxSourceRef,
  parseChannelOutboxSourceRef,
  resolveChannelOutboundAdapter,
  verifyPersistedInboxItem,
} from "./channel-outbox.ts";
import type { RepoCellBinding, RepoCellOperationalContext, RepoTaskAction } from "./repo-cell-types.ts";

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) reject("invalid_field", `${label} is required.`);
  return (value as string).trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function makeEnvelopeId(repoId: string, personId: string, idempotencyKey?: string): string {
  return idempotencyKey
    ? `ch_${createHash("sha256").update(`${repoId}:${personId}:${idempotencyKey}`).digest("hex").slice(0, 24)}`
    : `ch_${randomBytes(12).toString("hex")}`;
}

function receiptOf(
  envelopeId: string,
  channelKind: ChannelKind,
  direction: ChannelDirection,
  idempotencyKey: string,
  status: ChannelDeliveryReceipt["status"],
  principalPersonId: string,
  now: string,
  extra: Partial<ChannelDeliveryReceipt> = {},
): ChannelDeliveryReceipt {
  return {
    receiptId: `rcpt_${envelopeId}`,
    envelopeId,
    channelKind,
    direction,
    idempotencyKey,
    status,
    principalPersonId,
    deliveredAt: now,
    ...extra,
  };
}

function mapChannelKindToInboxFields(kind: ChannelKind): {
  admission: "dispatchable" | "quarantined_external";
  consumerKind: "interactive_watch" | "quarantined_external" | "unattended_dispatch";
} {
  switch (kind) {
    case "a2a-peer":
    case "cli":
    case "gui":
      return { admission: "dispatchable", consumerKind: "interactive_watch" };
    default:
      return { admission: "quarantined_external", consumerKind: "quarantined_external" };
  }
}

function parseInboundChannelKind(item: InboxItem): ChannelKind {
  const tagged = /^channel:(?:in:)?(cli|gui|a2a-peer|webhook|lark|custom):/u.exec(item.sourceRef)?.[1] as
    | ChannelKind
    | undefined;
  if (tagged) return tagged;
  if (item.source === "peer_request" || item.source === "peer_reply") return "a2a-peer";
  if (item.source === "external_ingress") return "webhook";
  return "custom";
}

function inboxItemToChannelListItem(item: InboxItem): ChannelListItem | null {
  const outboxRef = parseChannelOutboxSourceRef(item.sourceRef);
  const bodySha = item.requiredBlobSha256s[0];
  if (outboxRef) {
    const status: ChannelListItem["status"] =
      item.status === "completed"
        ? "delivered"
        : item.status === "failed"
          ? "failed"
          : item.status === "claimed"
            ? "pending_retry"
            : "accepted";
    return {
      itemId: item.itemId,
      channelKind: outboxRef.channelKind,
      direction: "outbound",
      summary: item.summary,
      status,
      principalPersonId: item.senderPersonId ?? "",
      recipientRef: outboxRef.recipientRef,
      correlationId: item.correlationId ?? undefined,
      inboxItemId: item.completedByDispatchId ?? item.itemId,
      ...(bodySha ? { bodyBlobSha256: bodySha } : {}),
      deliveredAt: item.settledAt ?? item.enqueuedAt,
    };
  }
  if (item.source === "peer_request") return null;
  const kind = parseInboundChannelKind(item);
  return {
    itemId: item.itemId,
    channelKind: kind,
    direction: "inbound",
    summary: item.summary,
    status: item.status === "quarantined_external" ? "pending_retry" : "delivered",
    principalPersonId: item.senderPersonId ?? "",
    senderRef: item.sourceRef,
    correlationId: item.correlationId ?? undefined,
    inboxItemId: item.itemId,
    ...(bodySha ? { bodyBlobSha256: bodySha } : {}),
    deliveredAt: item.enqueuedAt,
  };
}

function peerRequestToChannelListItem(request: PeerRequestV1, direction: ChannelDirection): ChannelListItem {
  return {
    itemId: direction === "outbound" ? `out:${request.requestId}` : request.requestId,
    channelKind: "a2a-peer",
    direction,
    summary: request.summary,
    status: request.state === "OPEN" ? "accepted" : request.state === "REJECTED" ? "rejected" : "delivered",
    principalPersonId: direction === "inbound" ? request.to.personId : request.from.personId,
    senderRef: request.from.personId,
    recipientRef: request.to.personId,
    correlationId: request.requestId,
    peerRequestId: request.requestId,
    deliveredAt: request.lastEventId,
  };
}

type ChannelListStage = "inbox" | "peer_in" | "peer_out";

function parseChannelListCursor(raw: string | undefined): {
  readonly stage: ChannelListStage;
  readonly cursor: string | undefined;
} {
  if (raw === undefined) return { stage: "inbox", cursor: undefined };
  const match = /^(inbox|peer_in|peer_out):([0-9]{1,16})$/u.exec(raw);
  if (!match) reject("invalid_field", `Channel list cursor is invalid: ${raw}`);
  const numeric = match![2]!;
  inboxQueueCursor(numeric);
  return { stage: match![1] as ChannelListStage, cursor: numeric === "0" ? undefined : numeric };
}

function listChannels(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  personId: string,
  opId: string,
): WriteReceiptDraft {
  const cut = cell.projection.readCut();
  const rawKind = optionalString(action.channelKind);
  if (rawKind && !(channelKinds as readonly string[]).includes(rawKind))
    reject("invalid_field", `Unsupported channel kind: ${rawKind}`);
  const channelKind = rawKind as ChannelKind | undefined;

  const rawDirection = optionalString(action.direction);
  if (rawDirection && !(channelDirections as readonly string[]).includes(rawDirection))
    reject("invalid_field", `Unsupported channel direction: ${rawDirection}`);
  const direction = rawDirection as ChannelDirection | undefined;

  const limit = channelPageLimit(typeof action.limit === "number" ? action.limit : undefined);
  const start = parseChannelListCursor(optionalString(action.cursor));
  const includePeer = !channelKind || channelKind === "a2a-peer";
  const includePeerIn = includePeer && (!direction || direction === "inbound");
  const includePeerOut = includePeer && (!direction || direction === "outbound");

  const items: ChannelListItem[] = [];
  let nextCursor: string | null = null;
  let stage: ChannelListStage = start.stage;
  let stageCursor: string | undefined = start.cursor;

  if (stage === "inbox") {
    let batchCursor = stageCursor;
    let batches = 0;
    let exhausted = false;
    while (items.length <= limit && batches < CHANNEL_LIST_SCAN_BATCHES) {
      batches += 1;
      const read = cell.projection.readInbox({
        by: "inbox",
        inboxId: `person:${personId}`,
        limit: channelPageLimit(limit),
        ...(batchCursor !== undefined ? { cursor: batchCursor } : {}),
      });
      if (read.status !== "ready") {
        exhausted = true;
        break;
      }
      for (const row of read.items) {
        const mapped = inboxItemToChannelListItem(row);
        if (!mapped) continue;
        if (channelKind && mapped.channelKind !== channelKind) continue;
        if (direction && mapped.direction !== direction) continue;
        if (items.length < limit) {
          items.push(mapped);
          batchCursor = String(row.enqueuedRevision);
        } else {
          nextCursor = `inbox:${batchCursor ?? "0"}`;
          break;
        }
      }
      if (nextCursor !== null) break;
      if (read.nextCursor === null) {
        exhausted = true;
        break;
      }
      batchCursor = read.nextCursor;
    }
    if (nextCursor === null && !exhausted && batchCursor !== undefined) nextCursor = `inbox:${batchCursor}`;
    if (nextCursor === null && exhausted) {
      stage = "peer_in";
      stageCursor = undefined;
    }
  }

  if (nextCursor === null && stage === "peer_in") {
    if (includePeerIn) {
      if (items.length >= limit) {
        const peek = cell.projection.readPeerRequests({
          by: "list",
          recipientPersonId: personId,
          limit: CHANNEL_LIST_SCAN_BATCHES,
          ...(stageCursor !== undefined ? { cursor: stageCursor } : {}),
        });
        if (peek.status === "ready" && peek.requests.some((req) => req.state !== "DONE" && req.state !== "REJECTED")) {
          nextCursor = `peer_in:${stageCursor ?? "0"}`;
        }
      } else {
        let batchCursor = stageCursor;
        let batches = 0;
        let exhausted = false;
        while (items.length < limit && batches < CHANNEL_LIST_SCAN_BATCHES) {
          batches += 1;
          const remaining = limit - items.length;
          const reqRead = cell.projection.readPeerRequests({
            by: "list",
            recipientPersonId: personId,
            limit: remaining,
            ...(batchCursor !== undefined ? { cursor: batchCursor } : {}),
          });
          if (reqRead.status !== "ready") {
            exhausted = true;
            break;
          }
          for (const req of reqRead.requests) {
            if (req.state === "DONE" || req.state === "REJECTED") continue;
            items.push(peerRequestToChannelListItem(req, "inbound"));
          }
          if (reqRead.nextCursor === null) {
            exhausted = true;
            break;
          }
          batchCursor = reqRead.nextCursor;
          if (items.length >= limit) {
            nextCursor = `peer_in:${batchCursor}`;
            break;
          }
        }
        if (nextCursor === null && !exhausted && batchCursor !== undefined) nextCursor = `peer_in:${batchCursor}`;
        if (nextCursor === null && exhausted && items.length === limit && includePeerOut) {
          const peek = cell.projection.readPeerRequests({ by: "list", senderPersonId: personId, limit: 1 });
          if (peek.status === "ready" && peek.requests.length > 0) nextCursor = "peer_out:0";
        }
      }
    }
    if (nextCursor === null) {
      stage = "peer_out";
      stageCursor = undefined;
    }
  }

  if (nextCursor === null && stage === "peer_out" && includePeerOut) {
    const remaining = limit - items.length;
    if (remaining > 0) {
      const reqRead = cell.projection.readPeerRequests({
        by: "list",
        senderPersonId: personId,
        limit: remaining,
        ...(stageCursor !== undefined ? { cursor: stageCursor } : {}),
      });
      if (reqRead.status === "ready") {
        for (const req of reqRead.requests) items.push(peerRequestToChannelListItem(req, "outbound"));
        if (reqRead.nextCursor !== null) nextCursor = `peer_out:${reqRead.nextCursor}`;
      }
    } else {
      const peek = cell.projection.readPeerRequests({
        by: "list",
        senderPersonId: personId,
        limit: 1,
        ...(stageCursor !== undefined ? { cursor: stageCursor } : {}),
      });
      if (peek.status === "ready" && peek.requests.length > 0) nextCursor = `peer_out:${stageCursor ?? "0"}`;
    }
  }

  return cell.readResult(opId, { items, nextCursor, watermark: cut.watermark }, cut.sourceRevision, null);
}

export function runChannelAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  opId: string,
): WriteReceiptDraft {
  const personId = binding.actor.principal.personId;
  const head = cell.store.readHead()?.revision ?? 0;
  const now = cell.now();

  if (action.kind === "channel-list") return listChannels(cell, action, personId, opId);

  if (action.kind === "channel-deliver") {
    const channelKind = requiredString(action.channelKind, "--channel") as ChannelKind;
    const principalPersonId = requiredString(action.principalPersonId ?? personId, "--principal");
    const summary = requiredString(action.summary, "--summary");
    const idempotencyKey = optionalString(action.idempotencyKey) ?? makeEnvelopeId(cell.input.repoId, personId);
    const envelopeId = optionalString(action.envelopeId) ?? makeEnvelopeId(cell.input.repoId, personId, idempotencyKey);

    const identity = verifyPeerSenderIdentity({
      claimedPersonId: principalPersonId,
      authenticatedPersonId: personId,
    });
    if (!identity.valid)
      reject(identity.errorCode, `Principal ${principalPersonId} does not match authenticated actor.`);

    const envelopePayload = {
      envelopeId,
      channelKind,
      idempotencyKey,
      principalPersonId,
      summary,
      ...(optionalString(action.body) ? { body: optionalString(action.body) } : {}),
      ...(optionalString(action.senderRef) ? { senderRef: optionalString(action.senderRef) } : {}),
      ...(optionalString(action.route) ? { route: optionalString(action.route) } : {}),
      ...(optionalString(action.correlationId) ? { correlationId: optionalString(action.correlationId) } : {}),
      ...(optionalString(action.workId) ? { workId: optionalString(action.workId) } : {}),
      ...(optionalString(action.lane) ? { lane: optionalString(action.lane) } : {}),
      ...(optionalString(action.anchorRef) ? { anchorRef: optionalString(action.anchorRef) } : {}),
      ...(channelKind === "a2a-peer"
        ? {
            peerPayload: {
              toPersonId: requiredString(action.toPersonId, "--to"),
              claim: requiredString(action.claim, "--claim"),
              requestedAction: requiredString(action.requestedAction, "--action"),
              ...(optionalString(action.requestKind) ? { requestKind: optionalString(action.requestKind) } : {}),
            },
          }
        : {}),
    };
    const issues = validateChannelInboxEnvelope(envelopePayload);
    if (issues.length > 0) reject("invalid_field", issues.join("; "));

    const participantRef =
      channelKind === "a2a-peer"
        ? requiredString(action.toPersonId, "--to")
        : (optionalString(action.senderRef) ?? personId);
    const dedupeKey = channelScopedDedupeKey({
      channelKind,
      direction: "inbound",
      principalPersonId,
      participantRef,
      idempotencyKey,
    });
    const targetInboxId = `person:${channelKind === "a2a-peer" ? requiredString(action.toPersonId, "--to") : principalPersonId}`;
    const existingInbox = cell.projection.readInbox({
      by: "dedupe",
      inboxId: targetInboxId,
      dedupeKey,
    });

    if (channelKind === "a2a-peer") {
      const toPersonId = requiredString(action.toPersonId, "--to");
      const requestId = makeEnvelopeId(cell.input.repoId, `${personId}:${toPersonId}`, idempotencyKey);
      const existingPeer = cell.projection.readPeerRequests({ by: "id", requestId });
      const persistedPeer = existingPeer.status === "ready" ? existingPeer.requests[0] : undefined;
      if ((existingInbox.status === "ready" && existingInbox.items.length > 0) || persistedPeer) {
        const rcpt = receiptOf(
          envelopeId,
          channelKind,
          "inbound",
          idempotencyKey,
          "duplicate",
          principalPersonId,
          now,
          {
            peerRequestId: persistedPeer?.requestId ?? requestId,
            inboxItemId:
              existingInbox.status === "ready"
                ? (existingInbox.items[0]?.itemId ?? `peer-req-${requestId}`)
                : `peer-req-${requestId}`,
          },
        );
        return {
          outcome: "no_changes",
          code: "no_changes",
          opId,
          revision: head,
          evidence: JSON.stringify({ receipt: rcpt, ...(persistedPeer ? { request: persistedPeer } : {}) }),
        };
      }
      const requestInput: PeerRequestInput = {
        requestId,
        from: { personId, nodeId: cell.input.repoId },
        to: {
          personId: toPersonId,
          ...(optionalString(action.workId) ? { workId: optionalString(action.workId) } : {}),
          ...(optionalString(action.lane) ? { lane: optionalString(action.lane) } : {}),
        },
        kind: (optionalString(action.requestKind) ?? "question") as PeerRequestInput["kind"],
        ...(optionalString(action.anchorRef) ? { anchorRef: optionalString(action.anchorRef) } : {}),
        summary,
        structuredBody: {
          claim: requiredString(action.claim, "--claim"),
          requestedAction: requiredString(action.requestedAction, "--action"),
        },
        attachments: [],
      };
      const openedRevision = head + 1;
      const openEvent = compilePeerRequestOpened(
        {
          eventId: `event-${opId}-open`,
          workspaceRevision: openedRevision,
          opId: `${opId}-open`,
          actor: binding.actor,
          source: binding.source,
          occurredAt: now,
        },
        { requestRevision: 1, request: requestInput },
      );
      const snapshot = reducePeerRequestEvent(null, openEvent);
      const inboxRevision = head + 2;
      const inboxFields = mapChannelKindToInboxFields(channelKind);
      const itemId = `peer-req-${requestId}`;
      const inboxBundle = buildInboxEnqueueBundle({
        opId,
        workspaceRevision: inboxRevision,
        actor: binding.actor,
        source: binding.source,
        occurredAt: now,
        payload: {
          inboxId: targetInboxId,
          itemId,
          source: "peer_request",
          sourceRef: requestId,
          sourceEpoch: 1,
          dedupeKey,
          admission: inboxFields.admission,
          consumerKind: inboxFields.consumerKind,
          taskId: null,
          agentId: null,
          senderPersonId: personId,
          workId: optionalString(action.workId) ?? null,
          lane: optionalString(action.lane) ?? null,
          correlationId: requestId,
          minRevision: inboxRevision,
          requiredBlobSha256s: [],
          summary,
          enqueuedAt: now,
        },
      });
      commitChannelBatch(cell, [
        { event: openEvent, plan: canonicalEventWritePlan(openEvent, "peer-request", requestId), blobs: [] },
        inboxBundle,
      ]);
      verifyPersistedInboxItem(cell, targetInboxId, itemId, dedupeKey);
      const rcpt = receiptOf(envelopeId, channelKind, "inbound", idempotencyKey, "routed", principalPersonId, now, {
        peerRequestId: requestId,
        inboxItemId: itemId,
      });
      return cell.readResult(opId, { receipt: rcpt, request: snapshot }, inboxRevision, null);
    }

    if (existingInbox.status === "ready" && existingInbox.items.length > 0) {
      const existingItem = existingInbox.items[0]!;
      const rcpt = receiptOf(envelopeId, channelKind, "inbound", idempotencyKey, "duplicate", principalPersonId, now, {
        inboxItemId: existingItem.itemId,
        ...(existingItem.requiredBlobSha256s[0] ? { bodyBlobSha256: existingItem.requiredBlobSha256s[0] } : {}),
      });
      return {
        outcome: "no_changes",
        code: "no_changes",
        opId,
        revision: head,
        evidence: JSON.stringify({ receipt: rcpt }),
      };
    }

    const inboxFields = mapChannelKindToInboxFields(channelKind);
    const source = channelInboxSource(channelKind);
    const inboxRevision = head + 1;
    const itemId = channelItemId(dedupeKey);
    const bodyContent = channelBodyContent(optionalString(action.body));
    const inboxBundle = buildInboxEnqueueBundle({
      opId,
      workspaceRevision: inboxRevision,
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        inboxId: targetInboxId,
        itemId,
        source,
        sourceRef: `channel:in:${channelKind}:${envelopeId}`,
        sourceEpoch: 1,
        dedupeKey,
        admission: inboxFields.admission,
        consumerKind: inboxFields.consumerKind,
        taskId: null,
        agentId: null,
        senderPersonId: personId,
        workId: optionalString(action.workId) ?? null,
        lane: optionalString(action.lane) ?? null,
        correlationId: optionalString(action.correlationId) ?? envelopeId,
        minRevision: inboxRevision,
        ...(bodyContent.claim
          ? { requiredBlobSha256s: [bodyContent.claim.sha256], bodyContentClaim: bodyContent.claim }
          : { requiredBlobSha256s: [] }),
        summary,
        enqueuedAt: now,
      },
      ...(bodyContent.blob ? { blobs: [bodyContent.blob] } : {}),
    });
    commitChannelBatch(cell, [inboxBundle]);
    const persisted = verifyPersistedInboxItem(cell, targetInboxId, itemId, dedupeKey);
    const rcpt = receiptOf(envelopeId, channelKind, "inbound", idempotencyKey, "accepted", principalPersonId, now, {
      inboxItemId: persisted.itemId,
      ...(bodyContent.claim ? { bodyBlobSha256: bodyContent.claim.sha256 } : {}),
    });
    return {
      ...cell.readResult(opId, { receipt: rcpt }, inboxRevision, null),
      authorizationDecision: binding.authorizationDecision,
    };
  }

  if (action.kind === "channel-send") {
    const channelKind = requiredString(action.channelKind, "--channel") as ChannelKind;
    const recipientRef = requiredString(action.recipientRef, "--to");
    const summary = requiredString(action.summary, "--summary");
    const idempotencyKey = optionalString(action.idempotencyKey) ?? makeEnvelopeId(cell.input.repoId, personId);
    const messageId = optionalString(action.messageId) ?? makeEnvelopeId(cell.input.repoId, personId, idempotencyKey);
    const route = optionalString(action.route);
    const body = optionalString(action.body);

    const messagePayload: ChannelOutboxMessage = {
      messageId,
      channelKind,
      idempotencyKey,
      principalPersonId: personId,
      summary,
      recipientRef,
      ...(body !== undefined ? { body } : {}),
      ...(route ? { route } : {}),
      ...(optionalString(action.correlationId) ? { correlationId: optionalString(action.correlationId) } : {}),
    };
    const issues = validateChannelOutboxMessage(messagePayload);
    if (issues.length > 0) reject("invalid_field", issues.join("; "));

    const adapter = resolveChannelOutboundAdapter(cell.input.repoId, messagePayload, cell.input.channelOutboundBridge);
    if (!adapter) reject("unsupported_command", `No ${channelKind} outbound adapter is registered for this route.`);

    const outboxInboxId = `person:${personId}`;
    const dedupeKey = channelScopedDedupeKey({
      channelKind,
      direction: "outbound",
      principalPersonId: personId,
      participantRef: recipientRef,
      idempotencyKey,
    });
    const existingOutbox = cell.projection.readInbox({
      by: "dedupe",
      inboxId: outboxInboxId,
      dedupeKey,
    });
    if (existingOutbox.status === "ready" && existingOutbox.items.length > 0) {
      const existingItem = existingOutbox.items[0]!;
      const retryDue =
        existingItem.status === "pending" ||
        (existingItem.status === "claimed" &&
          existingItem.leaseUntil !== null &&
          Date.parse(now) >= Date.parse(existingItem.leaseUntil));
      if (retryDue) {
        const replayed = drainChannelOutbox(cell, binding, {
          principalPersonId: personId,
          targetItemId: existingItem.itemId,
          now,
          opIdPrefix: opId,
          claimOpId: opId,
        });
        const replayReceipt =
          replayed.receipts[0] ??
          receiptOf(messageId, channelKind, "outbound", idempotencyKey, "pending_retry", personId, now, {
            recipientRef,
            inboxItemId: existingItem.itemId,
          });
        const finalRevision = cell.store.readHead()?.revision ?? head;
        return cell.readResult(opId, { receipt: replayReceipt }, finalRevision, null);
      }
      const duplicate = receiptOf(
        messageId,
        channelKind,
        "outbound",
        idempotencyKey,
        existingItem.status === "claimed" ? "pending_retry" : "duplicate",
        personId,
        now,
        {
          recipientRef,
          inboxItemId: existingItem.completedByDispatchId ?? existingItem.itemId,
          ...(existingItem.requiredBlobSha256s[0] ? { bodyBlobSha256: existingItem.requiredBlobSha256s[0] } : {}),
        },
      );
      return {
        outcome: "no_changes",
        code: "no_changes",
        opId,
        revision: head,
        evidence: JSON.stringify({ receipt: duplicate }),
      };
    }

    const outboxRevision = head + 1;
    const itemId = channelItemId(dedupeKey);
    const bodyContent = channelBodyContent(body);
    const outboxSourceRef = formatChannelOutboxSourceRef({
      channelKind,
      ...(route ? { route } : {}),
      recipientRef,
      messageId,
    });
    const outboxBundle = buildInboxEnqueueBundle({
      opId,
      workspaceRevision: outboxRevision,
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        inboxId: outboxInboxId,
        itemId,
        source: "channel_message",
        sourceRef: outboxSourceRef,
        sourceEpoch: 1,
        dedupeKey,
        admission: "dispatchable",
        consumerKind: "interactive_watch",
        taskId: null,
        agentId: null,
        senderPersonId: personId,
        workId: null,
        lane: null,
        correlationId: optionalString(action.correlationId) ?? messageId,
        minRevision: outboxRevision,
        ...(bodyContent.claim
          ? { requiredBlobSha256s: [bodyContent.claim.sha256], bodyContentClaim: bodyContent.claim }
          : { requiredBlobSha256s: [] }),
        summary,
        enqueuedAt: now,
      },
      ...(bodyContent.blob ? { blobs: [bodyContent.blob] } : {}),
    });
    commitChannelBatch(cell, [outboxBundle]);
    verifyPersistedInboxItem(cell, outboxInboxId, itemId, dedupeKey);

    const drained = drainChannelOutbox(cell, binding, {
      principalPersonId: personId,
      targetItemId: itemId,
      now,
      opIdPrefix: opId,
    });
    const finalReceipt =
      drained.receipts[0] ??
      receiptOf(messageId, channelKind, "outbound", idempotencyKey, "pending_retry", personId, now, {
        recipientRef,
        inboxItemId: itemId,
        ...(bodyContent.claim ? { bodyBlobSha256: bodyContent.claim.sha256 } : {}),
      });
    const finalRevision = cell.store.readHead()?.revision ?? outboxRevision;
    return cell.readResult(opId, { receipt: finalReceipt }, finalRevision, null);
  }

  reject("unsupported_command", `Unsupported channel action: ${action.kind}.`);
}

export function dispatchChannelAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  sourceRevision: number,
): WriteReceiptDraft | Promise<WriteReceiptDraft> {
  return cell.entityActionExecutor.run(
    action,
    binding,
    cell.operationId(action, binding, cell.input.repoId, sourceRevision),
    {
      entity: {
        channel: (_contract, intent, actor, opId) => runChannelAction(cell, intent, actor, opId),
      },
    },
  );
}
