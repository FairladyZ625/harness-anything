import {
  CHANNEL_LIST_SCAN_BATCHES,
  channelDirections,
  channelKinds,
  channelPageLimit,
  parseChannelOutboxSourceRef,
  type ChannelDirection,
  type ChannelKind,
  type ChannelListItem,
  type ChannelListResult,
} from "@harness-anything/kernel/internal/domain/channel-adapter.ts";
import { inboxQueueCursor, type InboxItem } from "@harness-anything/kernel/internal/domain/inbox.ts";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import type { TaskProjection, WriteReceiptDraft } from "@harness-anything/kernel";
import type { QueryAction, QueryOperationPort } from "./query-ports.ts";

export interface ChannelListQueryInput {
  readonly principalPersonId: string;
  readonly channelKind?: string;
  readonly direction?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ChannelListReadResult extends ChannelListResult {
  readonly sourceRevision: number;
}

export type ChannelQueryPort = Pick<QueryOperationPort, "projection" | "readResult" | "cellCodedError">;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function parseChannelListCursor(
  raw: string | undefined,
  invalidField: (message: string) => never,
): {
  readonly stage: ChannelListStage;
  readonly cursor: string | undefined;
} {
  if (raw === undefined) return { stage: "inbox", cursor: undefined };
  const match = /^(inbox|peer_in|peer_out):([0-9]{1,16})$/u.exec(raw);
  if (!match) invalidField(`Channel list cursor is invalid: ${raw}`);
  const numeric = match[2]!;
  inboxQueueCursor(numeric);
  return { stage: match[1] as ChannelListStage, cursor: numeric === "0" ? undefined : numeric };
}

export function readChannelList(
  projection: Pick<TaskProjection, "readCut" | "readInbox" | "readPeerRequests">,
  query: ChannelListQueryInput,
  invalidField: (message: string) => never,
): ChannelListReadResult {
  const cut = projection.readCut();
  const rawKind = optionalString(query.channelKind);
  if (rawKind && !(channelKinds as readonly string[]).includes(rawKind))
    invalidField(`Unsupported channel kind: ${rawKind}`);
  const channelKind = rawKind as ChannelKind | undefined;

  const rawDirection = optionalString(query.direction);
  if (rawDirection && !(channelDirections as readonly string[]).includes(rawDirection))
    invalidField(`Unsupported channel direction: ${rawDirection}`);
  const direction = rawDirection as ChannelDirection | undefined;

  const limit = channelPageLimit(typeof query.limit === "number" ? query.limit : undefined);
  const start = parseChannelListCursor(optionalString(query.cursor), invalidField);
  const includePeer = !channelKind || channelKind === "a2a-peer";
  const includePeerIn = includePeer && (!direction || direction === "inbound");
  const includePeerOut = includePeer && (!direction || direction === "outbound");
  const personId = query.principalPersonId;

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
      const read = projection.readInbox({
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
        const peek = projection.readPeerRequests({
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
          const reqRead = projection.readPeerRequests({
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
          const peek = projection.readPeerRequests({ by: "list", senderPersonId: personId, limit: 1 });
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
      const reqRead = projection.readPeerRequests({
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
      const peek = projection.readPeerRequests({
        by: "list",
        senderPersonId: personId,
        limit: 1,
        ...(stageCursor !== undefined ? { cursor: stageCursor } : {}),
      });
      if (peek.status === "ready" && peek.requests.length > 0) nextCursor = `peer_out:${stageCursor ?? "0"}`;
    }
  }

  return { items, nextCursor, watermark: cut.watermark, sourceRevision: cut.sourceRevision };
}

export function readChannelListAction(
  cell: ChannelQueryPort,
  action: QueryAction,
  personId: string,
  opId: string,
): WriteReceiptDraft {
  const result = readChannelList(
    cell.projection,
    {
      principalPersonId: personId,
      ...(typeof action.channelKind === "string" ? { channelKind: action.channelKind } : {}),
      ...(typeof action.direction === "string" ? { direction: action.direction } : {}),
      ...(typeof action.limit === "number" ? { limit: action.limit } : {}),
      ...(typeof action.cursor === "string" ? { cursor: action.cursor } : {}),
    },
    (message) => {
      throw cell.cellCodedError("invalid_field", message);
    },
  );
  return cell.readResult(
    opId,
    { items: result.items, nextCursor: result.nextCursor, watermark: result.watermark },
    result.sourceRevision,
    null,
  );
}
