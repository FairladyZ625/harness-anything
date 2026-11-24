import { createHash, randomBytes } from "node:crypto";
import type { CanonicalWriteBundle, WriteReceiptDraft } from "@harness-anything/kernel";
import {
  channelDedupeKey,
  channelInboxSource,
  channelPageLimit,
  validateChannelInboxEnvelope,
  validateChannelOutboxMessage,
  type ChannelDeliveryReceipt,
  type ChannelKind,
  type ChannelListItem,
} from "@harness-anything/kernel/internal/domain/channel-adapter.ts";
import {
  compilePeerRequestOpened,
  reducePeerRequestEvent,
  verifyPeerSenderIdentity,
  type PeerRequestInput,
  type PeerRequestV1,
} from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import {
  inboxDedupeKey,
  type InboxEventPayloads,
  type InboxItem,
} from "@harness-anything/kernel/internal/domain/inbox.ts";
import { compileInboxEnqueuedEvent } from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { reject } from "@harness-anything/application/internal/commands/entity-action-write-helpers.ts";
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

function buildInboxEnqueueBundle(input: {
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: RepoCellBinding["actor"];
  readonly source: RepoCellBinding["source"];
  readonly occurredAt: string;
  readonly payload: InboxEventPayloads["inbox_item_enqueued"];
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
  return { event, plan: canonicalEventWritePlan(event, "inbox", input.payload.inboxId), blobs: [] };
}

function commitBatch(cell: RepoCellOperationalContext, batch: readonly CanonicalWriteBundle[]): void {
  const final = batch[batch.length - 1]!;
  cell.store.append({ ...final, preceding: batch.slice(0, -1) });
  for (const item of batch) cell.projection.apply(item.event, item.plan);
}

function receiptOf(
  envelopeId: string,
  channelKind: ChannelKind,
  direction: "inbound" | "outbound",
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

function inboxItemToChannelListItem(item: InboxItem, kind: ChannelKind): ChannelListItem {
  return {
    itemId: item.itemId,
    channelKind: kind,
    direction: "inbound",
    summary: item.summary,
    status: item.status === "quarantined_external" ? "pending_retry" : "delivered",
    principalPersonId: item.senderPersonId ?? "",
    senderRef: item.sourceRef,
    correlationId: item.correlationId ?? undefined,
    peerRequestId: item.source === "peer_request" ? item.sourceRef : undefined,
    inboxItemId: item.itemId,
    deliveredAt: item.enqueuedAt,
  };
}

function peerRequestToChannelListItem(request: PeerRequestV1): ChannelListItem {
  return {
    itemId: request.requestId,
    channelKind: "a2a-peer",
    direction: "inbound",
    summary: request.summary,
    status: request.state === "OPEN" ? "accepted" : "delivered",
    principalPersonId: request.to.personId,
    senderRef: request.from.personId,
    correlationId: request.requestId,
    peerRequestId: request.requestId,
    deliveredAt: request.lastEventId,
  };
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

  if (action.kind === "channel-list") {
    const cut = cell.projection.readCut();
    const channelKind = optionalString(action.channelKind) as ChannelKind | undefined;
    const limit = channelPageLimit(typeof action.limit === "number" ? action.limit : undefined);
    const items: ChannelListItem[] = [];

    const inboxRead = cell.projection.readInbox({
      by: "queue",
      status: "pending",
      consumerKind: "interactive_watch",
      inboxId: `person:${personId}`,
      limit,
    });
    const externalRead = cell.projection.readInbox({
      by: "queue",
      status: "quarantined_external",
      consumerKind: "quarantined_external",
      inboxId: `person:${personId}`,
      limit,
    });
    const inboxItems = [
      ...(inboxRead.status === "ready" ? inboxRead.items : []),
      ...(externalRead.status === "ready" ? externalRead.items : []),
    ];
    for (const item of inboxItems) {
      const sourceChannel = /^channel:(cli|gui|a2a-peer|webhook|lark|custom):/u.exec(item.sourceRef)?.[1] as
        | ChannelKind
        | undefined;
      const kind: ChannelKind = sourceChannel ??
        (item.source === "peer_request" || item.source === "peer_reply"
          ? "a2a-peer"
          : item.source === "external_ingress"
            ? "webhook"
            : "custom");
      if (channelKind && kind !== channelKind) continue;
      items.push(inboxItemToChannelListItem(item, kind));
    }

    if (!channelKind || channelKind === "a2a-peer") {
      const reqRead = cell.projection.readPeerRequests({
        by: "list",
        recipientPersonId: personId,
        ...(typeof action.limit === "number" ? { limit: action.limit } : {}),
      });
      if (reqRead.status === "ready") {
        for (const req of reqRead.requests) {
          if (req.state === "DONE" || req.state === "REJECTED") continue;
          items.push(peerRequestToChannelListItem(req));
        }
      }
    }

    return cell.readResult(
      opId,
      { items: items.slice(0, limit), nextCursor: null, watermark: cut.watermark },
      cut.sourceRevision,
      null,
    );
  }

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

    const dedupeKey = channelDedupeKey({ channelKind, idempotencyKey });
    const existingInbox = cell.projection.readInbox({
      by: "dedupe",
      inboxId: `person:${channelKind === "a2a-peer" ? requiredString(action.toPersonId, "--to") : principalPersonId}`,
      dedupeKey,
    });
    if (existingInbox.status === "ready" && existingInbox.items.length > 0) {
      const rcpt = receiptOf(envelopeId, channelKind, "inbound", idempotencyKey, "duplicate", principalPersonId, now, {
        inboxItemId: existingInbox.items[0]!.itemId,
      });
      return cell.readResult(opId, { receipt: rcpt }, head, null);
    }

    if (channelKind === "a2a-peer") {
      const toPersonId = requiredString(action.toPersonId, "--to");
      const requestId = makeEnvelopeId(cell.input.repoId, personId, idempotencyKey);
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
      const inboxBundle = buildInboxEnqueueBundle({
        opId,
        workspaceRevision: inboxRevision,
        actor: binding.actor,
        source: binding.source,
        occurredAt: now,
        payload: {
          inboxId: `person:${toPersonId}`,
          itemId: `peer-req-${requestId}`,
          source: "peer_request",
          sourceRef: requestId,
          sourceEpoch: 1,
          dedupeKey: inboxDedupeKey({ source: "peer_request", sourceRef: requestId, sourceEpoch: 1 }),
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
      commitBatch(cell, [
        { event: openEvent, plan: canonicalEventWritePlan(openEvent, "peer-request", requestId), blobs: [] },
        inboxBundle,
      ]);
      const rcpt = receiptOf(envelopeId, channelKind, "inbound", idempotencyKey, "routed", principalPersonId, now, {
        peerRequestId: requestId,
        inboxItemId: `peer-req-${requestId}`,
      });
      return cell.readResult(opId, { receipt: rcpt, request: snapshot }, inboxRevision, null);
    }

    const inboxFields = mapChannelKindToInboxFields(channelKind);
    const source = channelInboxSource(channelKind);
    const targetPersonId = principalPersonId;
    const inboxRevision = head + 1;
    const itemId = `ch-in-${envelopeId}`;
    const inboxBundle = buildInboxEnqueueBundle({
      opId,
      workspaceRevision: inboxRevision,
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        inboxId: `person:${targetPersonId}`,
        itemId,
        source,
        sourceRef: `channel:${channelKind}:${envelopeId}`,
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
        requiredBlobSha256s: [],
        summary,
        enqueuedAt: now,
      },
    });
    commitBatch(cell, [inboxBundle]);
    const rcpt = receiptOf(envelopeId, channelKind, "inbound", idempotencyKey, "accepted", principalPersonId, now, {
      inboxItemId: itemId,
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

    const messagePayload = {
      messageId,
      channelKind,
      idempotencyKey,
      principalPersonId: personId,
      summary,
      recipientRef,
      ...(optionalString(action.body) ? { body: optionalString(action.body) } : {}),
      ...(optionalString(action.route) ? { route: optionalString(action.route) } : {}),
      ...(optionalString(action.correlationId) ? { correlationId: optionalString(action.correlationId) } : {}),
    };
    const issues = validateChannelOutboxMessage(messagePayload);
    if (issues.length > 0) reject("invalid_field", issues.join("; "));

    if (channelKind !== "gui" && !(channelKind === "webhook" && action.route === "local-loopback")) {
      reject("unsupported_command", `No ${channelKind} outbound adapter is registered for this route.`);
    }

    const dedupeKey = channelDedupeKey({ channelKind, idempotencyKey });
    const existingInbox = cell.projection.readInbox({
      by: "dedupe",
      inboxId: `person:${recipientRef}`,
      dedupeKey,
    });
    if (existingInbox.status === "ready" && existingInbox.items.length > 0) {
      const duplicate = receiptOf(messageId, channelKind, "outbound", idempotencyKey, "duplicate", personId, now, {
        recipientRef,
        inboxItemId: existingInbox.items[0]!.itemId,
      });
      return cell.readResult(opId, { receipt: duplicate }, head, null);
    }

    const inboxRevision = head + 1;
    const itemId = `ch-out-${messageId}`;
    const inboxBundle = buildInboxEnqueueBundle({
      opId,
      workspaceRevision: inboxRevision,
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        inboxId: `person:${recipientRef}`,
        itemId,
        source: channelInboxSource(channelKind),
        sourceRef: `channel:${channelKind}:${messageId}`,
        sourceEpoch: 1,
        dedupeKey,
        admission: channelKind === "gui" ? "dispatchable" : "quarantined_external",
        consumerKind: channelKind === "gui" ? "interactive_watch" : "quarantined_external",
        taskId: null,
        agentId: null,
        senderPersonId: personId,
        workId: null,
        lane: null,
        correlationId: optionalString(action.correlationId) ?? messageId,
        minRevision: inboxRevision,
        requiredBlobSha256s: [],
        summary,
        enqueuedAt: now,
      },
    });
    commitBatch(cell, [inboxBundle]);

    const rcpt = receiptOf(messageId, channelKind, "outbound", idempotencyKey, "delivered", personId, now, {
      recipientRef,
      inboxItemId: itemId,
    });
    return cell.readResult(opId, { receipt: rcpt }, inboxRevision, null);
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
