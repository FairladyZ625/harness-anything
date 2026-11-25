import { createHash, randomBytes } from "node:crypto";
import type { WriteReceiptDraft } from "@harness-anything/kernel";
import {
  channelInboxSource,
  validateChannelInboxEnvelope,
  validateChannelOutboxMessage,
  type ChannelDeliveryReceipt,
  type ChannelDirection,
  type ChannelKind,
  type ChannelOutboxMessage,
} from "@harness-anything/kernel/internal/domain/channel-adapter.ts";
import {
  compilePeerRequestOpened,
  reducePeerRequestEvent,
  verifyPeerSenderIdentity,
  type PeerRequestInput,
} from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import type { CommandAction, CommandBinding } from "./command-ports.ts";
import { reject } from "./entity-action-write-helpers.ts";
import {
  buildInboxEnqueueBundle,
  channelBodyContent,
  channelItemId,
  channelScopedDedupeKey,
  commitChannelBatch,
  drainChannelOutbox,
  formatChannelOutboxSourceRef,
  resolveBuiltinChannelOutboundAdapter,
  verifyPersistedInboxItem,
  type ChannelCommandCell,
  type ChannelOutboundAdapterResolver,
} from "./channel-outbox.ts";

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

export function runChannelWriteAction(
  cell: ChannelCommandCell,
  action: CommandAction,
  binding: CommandBinding,
  opId: string,
  options: { readonly resolveOutboundAdapter?: ChannelOutboundAdapterResolver } = {},
): WriteReceiptDraft {
  const personId = binding.actor.principal.personId;
  const head = cell.store.readHead()?.revision ?? 0;
  const now = cell.now();

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

    const resolveAdapter = options.resolveOutboundAdapter ?? resolveBuiltinChannelOutboundAdapter;
    const adapter = resolveAdapter(messagePayload);
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
          resolveAdapter,
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
      resolveAdapter,
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
