/**
 * Channel Adapter port contract (dec_166C5D2EAB57F8BCA3F15107E2 CH2).
 *
 * Abstracts channel-agnostic Inbox/Outbox messaging: CLI, GUI, A2A PeerRequest,
 * Webhook/loopback, and external IM adapters share one delivery surface without
 * coupling any specific SDK into the kernel.
 */
import type { EntityActionContract, EntityActionInputField } from "./entity-kind-registry.ts";
import type { EntityDocumentJsonSchema } from "./entity-json-schema.ts";
import type { InboxItemSource } from "./inbox.ts";
import type { OntologyJudgmentDeclaration, OntologyPolicyDeclaration } from "./ontology-source.ts";
import { isNonEmptyString, isRecord } from "./contract-validation.ts";

export const CHANNEL_ADAPTER_MODEL_VERSION = 1;

export const channelV1Schema: EntityDocumentJsonSchema<unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "channel/v1",
  type: "object",
  properties: {
    schema: { type: "string", const: "channel/v1" },
    envelopeId: { type: "string" },
    channelKind: { type: "string", enum: ["cli", "gui", "a2a-peer", "webhook", "lark", "custom"] },
    status: { type: "string" },
  },
  required: ["schema", "envelopeId", "channelKind"],
  additionalProperties: false,
};
export const CHANNEL_PAGE_LIMIT = 200;
export const CHANNEL_OUTBOX_RETRY_LEASE_MS = 1_000;
export const CHANNEL_LIST_SCAN_BATCHES = 10;
const CHANNEL_TEXT_LIMIT = 512;
const CHANNEL_SUMMARY_LIMIT = 1024;

export const channelKinds = ["cli", "gui", "a2a-peer", "webhook", "lark", "custom"] as const;
export type ChannelKind = (typeof channelKinds)[number];

export const channelDeliveryStatuses = [
  "accepted",
  "duplicate",
  "rejected",
  "routed",
  "delivered",
  "failed",
  "pending_retry",
] as const;
export type ChannelDeliveryStatus = (typeof channelDeliveryStatuses)[number];

export const channelDirections = ["inbound", "outbound"] as const;
export type ChannelDirection = (typeof channelDirections)[number];

/** Standardized inbound envelope any authorized adapter may deliver. */
export interface ChannelInboxEnvelope {
  readonly envelopeId: string;
  readonly channelKind: ChannelKind;
  readonly idempotencyKey: string;
  readonly principalPersonId: string;
  readonly summary: string;
  readonly body?: string;
  readonly senderRef?: string;
  readonly route?: string;
  readonly correlationId?: string;
  readonly workId?: string;
  readonly lane?: string;
  readonly anchorRef?: string;
  /** When channelKind is a2a-peer, structured payload for PeerRequest bridge. */
  readonly peerPayload?: {
    readonly toPersonId: string;
    readonly claim: string;
    readonly requestedAction: string;
    readonly requestKind?: string;
    readonly rootCause?: string;
    readonly verification?: string;
  };
}

/** Standardized outbound message routed by channelKind and route. */
export interface ChannelOutboxMessage {
  readonly messageId: string;
  readonly channelKind: ChannelKind;
  readonly idempotencyKey: string;
  readonly principalPersonId: string;
  readonly summary: string;
  readonly body?: string;
  readonly recipientRef: string;
  readonly route?: string;
  readonly correlationId?: string;
}

/** Idempotent delivery receipt returned to the adapter after each attempt. */
export interface ChannelDeliveryReceipt {
  readonly receiptId: string;
  readonly envelopeId: string;
  readonly channelKind: ChannelKind;
  readonly direction: ChannelDirection;
  readonly idempotencyKey: string;
  readonly status: ChannelDeliveryStatus;
  readonly principalPersonId: string;
  readonly inboxItemId?: string;
  readonly peerRequestId?: string;
  readonly recipientRef?: string;
  readonly bodyBlobSha256?: string;
  readonly reasonCode?: string;
  readonly deliveredAt: string;
}

/** Port contract: any channel adapter implements deliver + list. */
export interface ChannelAdapterPort {
  readonly channelKind: ChannelKind;
  deliver(envelope: ChannelInboxEnvelope): ChannelDeliveryReceipt;
  list(filter: ChannelListFilter): ChannelListResult;
  send(message: ChannelOutboxMessage): ChannelDeliveryReceipt;
}

export interface ChannelListFilter {
  readonly principalPersonId: string;
  readonly channelKind?: ChannelKind;
  readonly direction?: ChannelDirection;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ChannelListResult {
  readonly items: readonly ChannelListItem[];
  readonly nextCursor: string | null;
  readonly watermark: number;
}

export interface ChannelListItem {
  readonly itemId: string;
  readonly channelKind: ChannelKind;
  readonly direction: ChannelDirection;
  readonly summary: string;
  readonly status: ChannelDeliveryStatus;
  readonly principalPersonId: string;
  readonly senderRef?: string;
  readonly recipientRef?: string;
  readonly correlationId?: string;
  readonly peerRequestId?: string;
  readonly inboxItemId?: string;
  readonly bodyBlobSha256?: string;
  readonly deliveredAt: string;
}

/** Map channelKind to the Inbox source field used by Canonical Inbox. */
export function channelInboxSource(kind: ChannelKind): InboxItemSource {
  switch (kind) {
    case "a2a-peer":
      return "peer_request";
    case "webhook":
    case "lark":
    case "custom":
      return "external_ingress";
    case "cli":
    case "gui":
      return "channel_message";
  }
}

/** Derive a deterministic dedupe key from a channel envelope. */
export function channelDedupeKey(envelope: Pick<ChannelInboxEnvelope, "channelKind" | "idempotencyKey">): string {
  return `channel:${envelope.channelKind}:${envelope.idempotencyKey}`;
}

function boundedText(value: unknown, limit = CHANNEL_TEXT_LIMIT): boolean {
  return isNonEmptyString(value) && value.length <= limit && value.trim() === value;
}

function nullableText(value: unknown): boolean {
  return value === null || boundedText(value);
}

export function validateChannelInboxEnvelope(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["channel inbox envelope must be an object"];
  if (
    !boundedText(value.envelopeId) ||
    !(channelKinds as readonly unknown[]).includes(value.channelKind) ||
    !boundedText(value.idempotencyKey) ||
    !boundedText(value.principalPersonId) ||
    !boundedText(value.summary, CHANNEL_SUMMARY_LIMIT)
  )
    return ["channel inbox envelope required fields are invalid"];
  if (value.body !== undefined && typeof value.body !== "string")
    return ["channel inbox envelope body must be a string"];
  if (value.senderRef !== undefined && !nullableText(value.senderRef))
    return ["channel inbox envelope senderRef invalid"];
  if (value.route !== undefined && !nullableText(value.route)) return ["channel inbox envelope route invalid"];
  if (value.correlationId !== undefined && !nullableText(value.correlationId))
    return ["channel inbox envelope correlationId invalid"];
  if (value.workId !== undefined && !nullableText(value.workId)) return ["channel inbox envelope workId invalid"];
  if (value.lane !== undefined && !nullableText(value.lane)) return ["channel inbox envelope lane invalid"];
  if (value.anchorRef !== undefined && !nullableText(value.anchorRef))
    return ["channel inbox envelope anchorRef invalid"];
  if (value.channelKind === "a2a-peer") {
    if (!isRecord(value.peerPayload)) return ["a2a-peer channel requires peerPayload"];
    const p = value.peerPayload;
    if (!boundedText(p.toPersonId) || !boundedText(p.claim) || !boundedText(p.requestedAction))
      return ["a2a-peer peerPayload requires toPersonId, claim, and requestedAction"];
  }
  return [];
}

export function validateChannelOutboxMessage(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["channel outbox message must be an object"];
  if (
    !boundedText(value.messageId) ||
    !(channelKinds as readonly unknown[]).includes(value.channelKind) ||
    !boundedText(value.idempotencyKey) ||
    !boundedText(value.principalPersonId) ||
    !boundedText(value.summary, CHANNEL_SUMMARY_LIMIT) ||
    !boundedText(value.recipientRef)
  )
    return ["channel outbox message required fields are invalid"];
  if (value.body !== undefined && typeof value.body !== "string")
    return ["channel outbox message body must be a string"];
  if (value.route !== undefined && !nullableText(value.route)) return ["channel outbox message route invalid"];
  if (value.correlationId !== undefined && !nullableText(value.correlationId))
    return ["channel outbox message correlationId invalid"];
  return [];
}

export function channelPageLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, Math.trunc(limit ?? CHANNEL_PAGE_LIMIT)), CHANNEL_PAGE_LIMIT);
}

// --- Entity action catalog for channel CLI/GUI commands ---

const channelText = (field: string, required: boolean, flag?: string): EntityActionInputField => ({
  field,
  type: "string",
  required,
  ...(flag ? { cli: { name: flag, kind: "single", error: { code: "invalid_field" } } } : {}),
});
const channelFlagNum = (field: string, flag: string): EntityActionInputField => ({
  field,
  type: "number",
  required: false,
  cli: { name: flag, kind: "single", error: { code: "invalid_field" }, projection: "number" },
});
const channelIdempotencyField = channelText("idempotencyKey", false, "--idempotency-key");

export const channelActionDefinitions = [
  {
    id: "deliver",
    read: false,
    summary: "Deliver a standardized ChannelInboxEnvelope through an authorized adapter into Canonical Inbox.",
    fields: [
      channelText("channelKind", true, "--channel"),
      channelText("envelopeId", false, "--envelope-id"),
      channelText("principalPersonId", true, "--principal"),
      channelText("summary", true, "--summary"),
      channelText("body", false, "--body"),
      channelText("senderRef", false, "--sender"),
      channelText("route", false, "--route"),
      channelText("correlationId", false, "--correlation-id"),
      channelText("workId", false, "--work"),
      channelText("lane", false, "--lane"),
      channelText("anchorRef", false, "--anchor-ref"),
      channelText("toPersonId", false, "--to"),
      channelText("claim", false, "--claim"),
      channelText("requestedAction", false, "--action"),
      channelText("requestKind", false, "--kind"),
      channelIdempotencyField,
    ],
  },
  {
    id: "list",
    read: true,
    summary: "List channel Inbox/Outbox records filtered by channelKind for this principal.",
    fields: [
      channelText("channelKind", false, "--channel"),
      channelText("direction", false, "--direction"),
      channelFlagNum("limit", "--limit"),
      channelText("cursor", false, "--cursor"),
    ],
  },
  {
    id: "send",
    read: false,
    summary: "Route a ChannelOutboxMessage to the target channelKind and record an idempotent delivery receipt.",
    fields: [
      channelText("channelKind", true, "--channel"),
      channelText("messageId", false, "--message-id"),
      channelText("recipientRef", true, "--to"),
      channelText("summary", true, "--summary"),
      channelText("body", false, "--body"),
      channelText("route", false, "--route"),
      channelText("correlationId", false, "--correlation-id"),
      channelIdempotencyField,
    ],
  },
] as const;

export function createChannelActionCatalog(baseAction: (id: string) => EntityActionContract) {
  return {
    ref: "kernel/channel-action/v1",
    actions: channelActionDefinitions.map(
      ({ id, read, fields, summary }): EntityActionContract => ({
        ...baseAction(id),
        input: { schema: "entity-action-input/v1", fields, exactlyOneOf: [] },
        explain: summary,
        concurrency: {
          expectedVersion: {
            authority: "canonical-entity-revision",
            required: false,
            arbitration: "center-single-write-queue",
          },
          leasePolicy: { authority: "repository-writer-epoch" },
          occurrenceClaim: { authority: "not-applicable" },
          idempotency: { authority: "operation-id", input: "idempotencyKey" },
          artifactOwnership: { owner: "channel/{id}", path: "channel/{id}" },
        },
        effects: read ? [] : [{ ref: "channel_delivered", projection: "channel/v1" }],
        execution: {
          ingress: `channel-${id}`,
          compile: null,
          read,
          implementation: "catalog-runtime",
          topology: "center-forward-write",
          targetIdField: "envelopeId",
        },
      }),
    ),
  };
}

export const channelJudgments: readonly OntologyJudgmentDeclaration[] = [
  {
    id: "channel-inbox-envelope-validation",
    symbol: "packages/kernel/src/domain/channel-adapter.ts#validateChannelInboxEnvelope",
    inputs: ["unknown channel inbox envelope"],
    output: "readonly string[] validation issues",
    failureCodes: [],
    explain: "Validate ChannelInboxEnvelope field contracts before adapter delivery.",
    consumers: [],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/channel-adapter.ts#validateChannelInboxEnvelope:1a5c225ea42c5137c8e802a24053a4d5",
        route: "validateChannelInboxEnvelope",
      },
    ],
  },
  {
    id: "channel-outbox-message-validation",
    symbol: "packages/kernel/src/domain/channel-adapter.ts#validateChannelOutboxMessage",
    inputs: ["unknown channel outbox message"],
    output: "readonly string[] validation issues",
    failureCodes: [],
    explain: "Validate ChannelOutboxMessage field contracts before outbound routing.",
    consumers: [],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/channel-adapter.ts#validateChannelOutboxMessage:1a8beb11a225635a673dcc4be5de34c1",
        route: "validateChannelOutboxMessage",
      },
    ],
  },
];

export const channelPolicies: readonly OntologyPolicyDeclaration[] = [
  {
    id: "channel-delivery-bounds",
    ownerRef: "channel",
    unit: "items / envelope",
    bounds:
      "Channel reads cap at 200 items per page; every inbound delivery requires a unique idempotencyKey per channelKind; principal RBAC must match authenticated actor or be explicitly authorized.",
    defaultValue: CHANNEL_PAGE_LIMIT,
    version: 1,
    scope: "Channel adapter delivery and list reads",
    reason: "Keep channel bridge reads bounded and prevent duplicate deliveries across adapters.",
    fixtures: ["packages/kernel/test/channel-adapter.test.ts", "packages/daemon/test/channel-adapter.test.ts"],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/channel-adapter.ts#CHANNEL_PAGE_LIMIT:3a112e684a63898ad4fd759742b49a9a",
        route: "channel-list",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/channel-adapter.ts#CHANNEL_TEXT_LIMIT:d54d7cabd9176f6e1ff7429809e3d0b1",
        route: "channel-deliver",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/channel-adapter.ts#CHANNEL_SUMMARY_LIMIT:76da27778b93d01a7158f44bc524778a",
        route: "channel-deliver",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/status-word-register.ts#statusWordRegister.meaning.pending_retry:f8f9d5608d562a84d2808d2886613589",
        route: "channel-delivery-receipt",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-action.ts#mapChannelKindToInboxFields.admission:0434b29be0266d9440715451ee9874bd",
        route: "channel-deliver",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-action.ts#mapChannelKindToInboxFields.admission:0434b29be0266d9440715451ee9874bd:2",
        route: "channel-deliver",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-action.ts#mapChannelKindToInboxFields.admission:69555a6e6f1643ab3a00a0821f0aeb81",
        route: "channel-deliver",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/channel-adapter.ts#CHANNEL_OUTBOX_RETRY_LEASE_MS:16d04b1cfb5240d7e116a0109bac3632",
        route: "channel-send",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-action.ts#listChannels.limit:fff62423ddf2d7fd97d1e51e8d55a7f3",
        route: "channel-list",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-action.ts#listChannels.peek.limit:0dd585c292e12f6bf0b47a1d330750d6",
        route: "channel-list",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-action.ts#listChannels.peek.limit:0dd585c292e12f6bf0b47a1d330750d6:2",
        route: "channel-list",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-action.ts#runChannelAction.outboxBundle.payload.admission:0434b29be0266d9440715451ee9874bd",
        route: "channel-send",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-outbox.ts#channelBodyContent.claim:e0130c37b9c7c5562aa0250620b8111b",
        route: "channel-deliver",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-outbox.ts#deliverPeerOutbound.inboxBundle.payload.admission:0434b29be0266d9440715451ee9874bd",
        route: "channel-send",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-outbox.ts#drainChannelOutbox:3ffcfb2097bbc6954303a6bfb6202064",
        route: "channel-send",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-outbox.ts#drainChannelOutbox:17cbd1941c3fe9420f5d2cd1c103f7f5",
        route: "channel-send",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/channel-outbox.ts#drainChannelOutbox:9f420de8bd36962f153b7a75f52d1e9d",
        route: "channel-send",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/inbox.ts#enqueuedIssues:979a4db5b94b6f3344b365dd51edb2d0",
        route: "channel-deliver",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/ports/canonical-document-claims.ts#contentClaims.claims:b477d628692f3f4b3e71420f3dc45d52",
        route: "channel-deliver",
      },
      {
        candidateId:
          "policy:packages/gui:packages/gui/src/renderer/views/agenda/AgendaChannelPanel.tsx#AgendaChannelPanel.claim:66f77ec98797d81477035bf5f64fca80",
        route: "peer-reply",
      },
      {
        candidateId:
          "policy:packages/gui:packages/gui/src/renderer/views/agenda/AgendaChannelPanel.tsx#AgendaChannelPanel.submitReply.claim:66f77ec98797d81477035bf5f64fca80",
        route: "peer-reply",
      },
    ],
  },
];
