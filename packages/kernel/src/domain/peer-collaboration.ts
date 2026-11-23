import { isNonEmptyString, isRecord } from "./contract-validation.ts";
import {
  validateEntityJsonSchema,
  type EntityDocumentJsonSchema,
  type EntityJsonSchemaNode,
} from "./entity-json-schema.ts";
import { validateEventEnvelopeIdentity, type ActorIdentity, type EventEnvelope } from "./write-chain.contract.ts";

export const PEER_REQUEST_MODEL_VERSION = 1;
export const PEER_REQUEST_PAGE_LIMIT = 200;

export const peerRequestStates = ["OPEN", "CLAIMED", "ANSWERED", "DONE", "REJECTED", "PROMOTED"] as const;
export type PeerRequestState = (typeof peerRequestStates)[number];

export const peerRequestEventTypes = [
  "peer_request_opened",
  "peer_request_claimed",
  "peer_request_answered",
  "peer_request_done",
  "peer_request_rejected",
  "peer_request_promoted",
] as const;

export const peerRequestKinds = ["question", "ops-request", "merge-request", "handoff"] as const;
export type PeerRequestKind = (typeof peerRequestKinds)[number];

export interface PeerStructuredBody {
  readonly claim: string;
  readonly rootCause?: string;
  readonly requestedAction: string;
  readonly verification?: string;
}

export interface PeerAttachment {
  readonly sha256: `sha256:${string}`;
  readonly mediaType: string;
  readonly access: "read-only";
  readonly size?: number;
}

export interface ContinuationPacket {
  readonly anchorRef: string;
  readonly wipCommitSha: string;
  readonly wipBundleBlobSha256?: `sha256:${string}`;
  readonly prNumber?: number;
  readonly verifiedReceipts: readonly string[];
  readonly inFlightDispatches: readonly string[];
  readonly blockingGate: string | null;
  readonly nextAction: string;
}

export interface PeerRequestInput {
  readonly requestId: string;
  readonly from: { readonly personId: string; readonly nodeId: string; readonly sessionHint?: string };
  readonly to: { readonly personId: string; readonly workId?: string; readonly lane?: string };
  readonly kind: PeerRequestKind;
  readonly anchorRef?: string;
  readonly summary: string;
  readonly structuredBody: PeerStructuredBody;
  readonly attachments: readonly PeerAttachment[];
  readonly continuationPacket?: ContinuationPacket;
}

export interface PeerReply {
  readonly structuredBody: PeerStructuredBody;
  readonly attachments: readonly PeerAttachment[];
  readonly minRevision: number;
}

export interface PeerClaim {
  readonly claimId: string;
  readonly expiresAt: string;
}

interface PeerRequestSnapshot extends PeerRequestInput {
  readonly schema: "peer-request/v1";
  readonly revision: number;
  readonly lastEventId: string;
  readonly claim: PeerClaim | null;
  readonly reply: PeerReply | null;
  readonly rejectionReason: string | null;
}

export type PeerRequestV1 = PeerRequestSnapshot &
  (
    | { readonly state: Exclude<PeerRequestState, "PROMOTED">; readonly promotedTaskId: null }
    | { readonly state: "PROMOTED"; readonly promotedTaskId: string }
  );

interface PeerEventPayloads {
  readonly peer_request_opened: { readonly request: PeerRequestInput };
  readonly peer_request_claimed: { readonly requestId: string; readonly expiresAt: string };
  readonly peer_request_answered: { readonly requestId: string; readonly claimId: string; readonly reply: PeerReply };
  readonly peer_request_done: { readonly requestId: string; readonly claimId: string };
  readonly peer_request_rejected: { readonly requestId: string; readonly claimId: string; readonly reason: string };
  readonly peer_request_promoted: {
    readonly requestId: string;
    readonly claimId: string;
    readonly promotedTaskId: string;
  };
}

export type PeerEventType = (typeof peerRequestEventTypes)[number];
export type PeerRequestEventV1 = {
  [T in PeerEventType]: EventEnvelope<
    "peer-request-event/v1",
    T,
    ActorIdentity,
    PeerEventPayloads[T] & { readonly requestRevision: number }
  >;
}[PeerEventType];

export type PeerRequestErrorCode =
  | "peer_request_invalid_input"
  | "peer_request_transition_invalid"
  | "peer_request_revision_gap"
  | "peer_request_event_conflict"
  | "peer_request_id_mismatch"
  | "peer_request_claim_lease_active"
  | "peer_request_claim_expired"
  | "peer_request_claim_mismatch"
  | "peer_request_recipient_mismatch"
  | "peer_request_promotion_task_required"
  | "peer_sender_spoofing_denied";

export class PeerRequestDomainError extends Error {
  readonly code: PeerRequestErrorCode;

  constructor(code: PeerRequestErrorCode, message: string) {
    super(message);
    this.name = "PeerRequestDomainError";
    this.code = code;
  }
}

export function verifyPeerSenderIdentity(input: {
  readonly claimedPersonId: string;
  readonly authenticatedPersonId: string;
}): { readonly valid: true } | { readonly valid: false; readonly errorCode: "peer_sender_spoofing_denied" } {
  return isNonEmptyString(input.authenticatedPersonId) && input.claimedPersonId === input.authenticatedPersonId
    ? { valid: true }
    : { valid: false, errorCode: "peer_sender_spoofing_denied" };
}

const peerIntentTiers = Object.freeze({
  "read-only-diagnostic": "L0",
  "shared-ledger-write": "L1",
  merge: "L1",
  "host-privileged": "L2",
} as const);
export type PeerIntentRiskTier = (typeof peerIntentTiers)[keyof typeof peerIntentTiers];

/** Classify the operation selected by the receiver's trusted action catalog. */
export function classifyPeerIntentRiskTier(operation: string): PeerIntentRiskTier {
  return Object.hasOwn(peerIntentTiers, operation) ? peerIntentTiers[operation as keyof typeof peerIntentTiers] : "L2";
}

/** The evidence comes from the receiver's local preflight and confirmation for the selected operation. */
export function evaluatePeerExecutionCeiling(
  tier: PeerIntentRiskTier,
  evidence: { readonly preflightPassed?: boolean; readonly humanConfirmed?: boolean } = {},
) {
  switch (tier) {
    case "L0":
      return { tier, ceiling: "read-only" } as const;
    case "L1":
      if (evidence.humanConfirmed !== true)
        return {
          tier,
          ceiling: "local-human-confirmation-required",
          errorCode: "peer_local_human_confirmation_required",
        } as const;
      if (evidence.preflightPassed !== true)
        return {
          tier,
          ceiling: "local-preflight-required",
          errorCode: "peer_local_preflight_required",
        } as const;
      return { tier, ceiling: "write" } as const;
    default:
      return { tier: "L2", ceiling: "draft_only" } as const;
  }
}

export function matchesPeerWatchFilter(
  item: {
    readonly source: "peer_request" | "peer_reply";
    readonly correlationId?: string;
    readonly workId?: string;
    readonly lane?: string;
  },
  filter: { readonly replyTo?: string; readonly workId?: string; readonly lane?: string },
): boolean {
  if (filter.replyTo !== undefined || item.source === "peer_reply") {
    return item.source === "peer_reply" && filter.replyTo !== undefined && filter.replyTo === item.correlationId;
  }
  if (filter.workId !== undefined || item.workId !== undefined) {
    return filter.workId !== undefined && filter.workId === item.workId;
  }
  return filter.lane === (item.lane ?? "default");
}

export function isPeerFrameCausallyReady(input: {
  readonly minRevision: number;
  readonly requiredBlobSha256s: readonly string[];
  readonly localWatermark: number;
  readonly hasLocalBlob: (sha256: string) => boolean;
}): boolean {
  return (
    Number.isSafeInteger(input.minRevision) &&
    input.minRevision >= 0 &&
    Number.isSafeInteger(input.localWatermark) &&
    input.localWatermark >= input.minRevision &&
    input.requiredBlobSha256s.every((sha256) => input.hasLocalBlob(sha256))
  );
}

const textField = { type: "string", minLength: 1 } as const;
const idField = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" } as const;
const revisionField = { type: "integer", integer: true, minimum: 1 } as const;
const nullableText = { ...textField, "x-nullable": true } as const;
const objectFields = (properties: Readonly<Record<string, EntityJsonSchemaNode>>, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const;

const structuredBody = objectFields(
  { claim: textField, rootCause: textField, requestedAction: textField, verification: textField },
  ["claim", "requestedAction"],
);
const sha256Field = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } as const;
const attachments = {
  type: "array",
  items: objectFields(
    {
      sha256: sha256Field,
      mediaType: textField,
      access: { type: "string", const: "read-only" },
      size: { type: "integer", integer: true, minimum: 0 },
    },
    ["sha256", "mediaType", "access"],
  ),
} as const;
const continuationPacketFields = objectFields(
  {
    anchorRef: textField,
    wipCommitSha: { type: "string", pattern: "^[0-9a-f]{7,64}$" },
    wipBundleBlobSha256: sha256Field,
    prNumber: { type: "integer", integer: true, minimum: 1 },
    verifiedReceipts: { type: "array", items: textField },
    inFlightDispatches: { type: "array", items: textField },
    blockingGate: nullableText,
    nextAction: textField,
  },
  ["anchorRef", "wipCommitSha", "verifiedReceipts", "inFlightDispatches", "blockingGate", "nextAction"],
);
const replyFields = objectFields({
  structuredBody,
  attachments,
  minRevision: { type: "integer", integer: true, minimum: 0 },
});
const requestFields = objectFields(
  {
    requestId: idField,
    from: objectFields({ personId: textField, nodeId: textField, sessionHint: textField }, ["personId", "nodeId"]),
    to: objectFields({ personId: textField, workId: textField, lane: textField }, ["personId"]),
    kind: { type: "string", enum: peerRequestKinds },
    anchorRef: textField,
    summary: { ...textField, pattern: "^[^\\r\\n\\u2028\\u2029]{1,240}$(?![\\s\\S])" },
    structuredBody,
    attachments,
    continuationPacket: continuationPacketFields,
  },
  ["requestId", "from", "to", "kind", "summary", "structuredBody", "attachments"],
);
const schemaDialect = "https://json-schema.org/draft/2020-12/schema" as const;
const promotedTaskDiscriminator = [
  {
    type: "object",
    properties: { state: { type: "string", const: "PROMOTED" }, promotedTaskId: idField },
    required: ["state", "promotedTaskId"],
    additionalProperties: true,
  },
  {
    type: "object",
    properties: {
      state: { type: "string", enum: peerRequestStates.filter((state) => state !== "PROMOTED") },
      promotedTaskId: { type: "null" },
    },
    required: ["state", "promotedTaskId"],
    additionalProperties: true,
  },
] as const;

export const peerRequestV1JsonSchema: EntityDocumentJsonSchema<PeerRequestV1> = {
  $schema: schemaDialect,
  $id: "PeerRequest/v1",
  ...objectFields(
    {
      ...requestFields.properties,
      schema: { type: "string", const: "peer-request/v1" },
      state: { type: "string", enum: peerRequestStates },
      revision: revisionField,
      lastEventId: textField,
      claim: { ...objectFields({ claimId: textField, expiresAt: textField }), "x-nullable": true },
      reply: { ...replyFields, "x-nullable": true },
      rejectionReason: nullableText,
      promotedTaskId: { ...idField, "x-nullable": true },
    },
    [
      ...requestFields.required,
      "schema",
      "state",
      "revision",
      "lastEventId",
      "claim",
      "reply",
      "rejectionReason",
      "promotedTaskId",
    ],
  ),
  oneOf: promotedTaskDiscriminator,
};

const terminalFields = { requestId: idField, claimId: textField };
const peerPayloadFields = {
  peer_request_opened: { request: requestFields },
  peer_request_claimed: { requestId: idField, expiresAt: textField },
  peer_request_answered: { ...terminalFields, reply: replyFields },
  peer_request_done: terminalFields,
  peer_request_rejected: { ...terminalFields, reason: textField },
  peer_request_promoted: { ...terminalFields, promotedTaskId: idField },
} satisfies Record<PeerEventType, Readonly<Record<string, EntityJsonSchemaNode>>>;

function eventContractIssues(event: PeerRequestEventV1): readonly string[] {
  const schema = {
    $schema: schemaDialect,
    $id: "peer-request-event/v1",
    ...objectFields({ requestRevision: revisionField, ...peerPayloadFields[event.type] }),
  };
  const issues = validateEntityJsonSchema(schema, event.payload, "PeerRequest event payload");
  if (issues.length > 0) return issues;
  if (event.type === "peer_request_claimed" && !isValidTimestamp(event.payload.expiresAt))
    return ["expiresAt must be an ISO timestamp"];
  return [];
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

/** Fold an event at its writer-stamped time so replay after lease expiry has the same result. */
export function reducePeerRequestEvent(current: PeerRequestV1 | null, event: PeerRequestEventV1): PeerRequestV1 {
  if (!isRecord(event) || event.schema !== "peer-request-event/v1" || !peerRequestEventTypes.includes(event.type))
    throw new PeerRequestDomainError("peer_request_invalid_input", "Invalid PeerRequest event schema or type.");
  const envelopeIssues = validateEventEnvelopeIdentity(event);
  if (envelopeIssues.length > 0)
    throw new PeerRequestDomainError("peer_request_invalid_input", envelopeIssues.join(", "));
  const payloadIssues = eventContractIssues(event);
  if (payloadIssues.length > 0) {
    const code =
      event.type === "peer_request_promoted" && payloadIssues.some((issue) => issue.includes('"promotedTaskId"'))
        ? "peer_request_promotion_task_required"
        : "peer_request_invalid_input";
    throw new PeerRequestDomainError(code, payloadIssues.join(", "));
  }

  const personId = event.actor.principal.personId;
  const { requestRevision: revision } = event.payload;
  const requestId = event.type === "peer_request_opened" ? event.payload.request.requestId : event.payload.requestId;
  if (event.type === "peer_request_opened") {
    const identity = verifyPeerSenderIdentity({
      claimedPersonId: event.payload.request.from.personId,
      authenticatedPersonId: personId,
    });
    if (!identity.valid)
      throw new PeerRequestDomainError(
        identity.errorCode,
        "PeerRequest sender must match the authenticated principal.",
      );
  }
  if (current === null) {
    if (event.type !== "peer_request_opened" || revision !== 1)
      throw new PeerRequestDomainError(
        "peer_request_transition_invalid",
        "A PeerRequest starts with its opening event at revision 1.",
      );
    return openPeerRequest(event.payload.request, event.eventId);
  }

  if (requestId !== current.requestId)
    throw new PeerRequestDomainError("peer_request_id_mismatch", "PeerRequest event targets a different request.");
  if (revision < current.revision || (revision === current.revision && event.eventId === current.lastEventId))
    return current;
  if (revision === current.revision || event.eventId === current.lastEventId)
    throw new PeerRequestDomainError(
      "peer_request_event_conflict",
      "PeerRequest event identity and revision disagree.",
    );
  if (revision !== current.revision + 1)
    throw new PeerRequestDomainError("peer_request_revision_gap", "PeerRequest event revision must advance by one.");
  if (event.type === "peer_request_opened")
    throw new PeerRequestDomainError("peer_request_transition_invalid", "A PeerRequest can only be opened once.");
  if (personId !== current.to.personId)
    throw new PeerRequestDomainError(
      "peer_request_recipient_mismatch",
      "Only the addressed principal may act on this PeerRequest.",
    );

  const next = { ...current, revision, lastEventId: event.eventId };
  const at = Date.parse(event.occurredAt);
  if (event.type === "peer_request_claimed") {
    if (current.state !== "OPEN" && current.state !== "CLAIMED")
      throw new PeerRequestDomainError(
        "peer_request_transition_invalid",
        "Only an open or expired request can be claimed.",
      );
    if (current.claim !== null && Date.parse(current.claim.expiresAt) > at)
      throw new PeerRequestDomainError("peer_request_claim_lease_active", "PeerRequest already has an active claim.");
    if (Date.parse(event.payload.expiresAt) <= at)
      throw new PeerRequestDomainError(
        "peer_request_claim_expired",
        "A new PeerRequest claim must have a future expiry.",
      );
    const claim = Object.freeze({ claimId: event.eventId, expiresAt: event.payload.expiresAt });
    return Object.freeze({ ...next, state: "CLAIMED", claim, promotedTaskId: null });
  }

  if (current.state !== "CLAIMED" || current.claim === null)
    throw new PeerRequestDomainError(
      "peer_request_transition_invalid",
      "A terminal transition requires a claimed request.",
    );
  if (event.payload.claimId !== current.claim.claimId)
    throw new PeerRequestDomainError(
      "peer_request_claim_mismatch",
      "PeerRequest transition must use the current claim.",
    );
  if (Date.parse(current.claim.expiresAt) <= at)
    throw new PeerRequestDomainError("peer_request_claim_expired", "PeerRequest claim expired before its transition.");

  switch (event.type) {
    case "peer_request_answered":
      return Object.freeze({
        ...next,
        state: "ANSWERED",
        reply: freezePeerContent(event.payload.reply),
        promotedTaskId: null,
      });
    case "peer_request_done":
      return Object.freeze({ ...next, state: "DONE", promotedTaskId: null });
    case "peer_request_rejected":
      return Object.freeze({ ...next, state: "REJECTED", rejectionReason: event.payload.reason, promotedTaskId: null });
    case "peer_request_promoted":
      return Object.freeze({ ...next, state: "PROMOTED", promotedTaskId: event.payload.promotedTaskId });
  }
}

function openPeerRequest(input: PeerRequestInput, eventId: string): PeerRequestV1 {
  return Object.freeze({
    ...freezePeerContent(input),
    from: Object.freeze({ ...input.from }),
    to: Object.freeze({ ...input.to }),
    ...(input.continuationPacket === undefined
      ? {}
      : {
          continuationPacket: Object.freeze({
            ...input.continuationPacket,
            verifiedReceipts: Object.freeze([...input.continuationPacket.verifiedReceipts]),
            inFlightDispatches: Object.freeze([...input.continuationPacket.inFlightDispatches]),
          }),
        }),
    schema: "peer-request/v1",
    state: "OPEN",
    revision: 1,
    lastEventId: eventId,
    claim: null,
    reply: null,
    rejectionReason: null,
    promotedTaskId: null,
  });
}

function freezePeerContent(input: PeerReply): PeerReply;
function freezePeerContent(input: PeerRequestInput): PeerRequestInput;
function freezePeerContent(input: PeerReply | PeerRequestInput): PeerReply | PeerRequestInput {
  return Object.freeze({
    ...input,
    structuredBody: Object.freeze({ ...input.structuredBody }),
    attachments: Object.freeze(input.attachments.map((attachment) => Object.freeze({ ...attachment }))),
  }) as PeerReply | PeerRequestInput;
}

export function isPeerRequestEventType(type: string): type is PeerEventType {
  return (peerRequestEventTypes as readonly string[]).includes(type);
}

export function isPeerRequestEvent(event: { readonly schema: string; readonly type: string }): event is PeerRequestEventV1 {
  return event.schema === "peer-request-event/v1" && isPeerRequestEventType(event.type);
}

export function peerRequestEventRequestId(event: PeerRequestEventV1): string {
  return event.type === "peer_request_opened" ? event.payload.request.requestId : event.payload.requestId;
}

export function isTerminalPeerRequestState(state: PeerRequestState): boolean {
  return state === "ANSWERED" || state === "DONE" || state === "REJECTED" || state === "PROMOTED";
}

export function validatePeerRequestEvent(value: unknown): readonly string[] {
  if (!isRecord(value) || value.schema !== "peer-request-event/v1" || !isPeerRequestEventType(String(value.type)))
    return ["Invalid PeerRequest event schema or type."];
  const envelopeIssues = validateEventEnvelopeIdentity(value);
  if (envelopeIssues.length > 0) return envelopeIssues;
  return eventContractIssues(value as unknown as PeerRequestEventV1);
}

export function validateCurrentPeerRequestEvent(value: unknown): readonly string[] {
  return validatePeerRequestEvent(value);
}

export function peerRequestEventContentClaims(event: PeerRequestEventV1): readonly {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  const list =
    event.type === "peer_request_opened"
      ? event.payload.request.attachments
      : event.type === "peer_request_answered"
        ? event.payload.reply.attachments
        : [];
  return list.flatMap((attachment) =>
    attachment.size === undefined
      ? []
      : [
          {
            sha256: attachment.sha256.slice("sha256:".length),
            size: attachment.size,
            mediaType: attachment.mediaType,
          },
        ],
  );
}

export type PeerRequestQuery =
  | { readonly by: "id"; readonly requestId: string }
  | {
      readonly by: "list";
      readonly recipientPersonId?: string;
      readonly senderPersonId?: string;
      readonly state?: PeerRequestState;
      readonly kind?: PeerRequestKind;
      readonly workId?: string;
      readonly lane?: string;
      readonly limit?: number;
      readonly cursor?: string;
    };

export type PeerRequestRead =
  | { readonly status: "pending"; readonly watermark: number; readonly sourceRevision: number }
  | {
      readonly status: "ready";
      readonly watermark: number;
      readonly sourceRevision: number;
      readonly requests: readonly PeerRequestV1[];
      readonly nextCursor: string | null;
    };

export function peerRequestPageLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, Math.trunc(limit ?? PEER_REQUEST_PAGE_LIMIT)), PEER_REQUEST_PAGE_LIMIT);
}

export function peerRequestCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(cursor)) throw new Error(`peer request cursor is invalid: ${cursor}`);
  return Number(cursor);
}

export function peerRequestNextCursor(rows: readonly { readonly openedRevision: number }[], limit: number): string | null {
  return rows.length > limit ? String(rows[limit - 1]!.openedRevision) : null;
}
