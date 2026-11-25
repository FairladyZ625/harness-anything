import { isNonEmptyString, isRecord } from "./contract-validation.ts";
import type { EntityActionContract, EntityActionInputField } from "./entity-kind-registry.ts";
import {
  validateEntityJsonSchema,
  type EntityDocumentJsonSchema,
  type EntityJsonObjectSchema,
  type EntityJsonSchemaNode,
} from "./entity-json-schema.ts";
import type { OntologyJudgmentDeclaration, OntologyPolicyDeclaration } from "./ontology-source.ts";
import {
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type WriteSource,
} from "./write-chain.contract.ts";

export const PEER_REQUEST_MODEL_VERSION = 1;
export const PEER_REQUEST_PAGE_LIMIT = 200;
export const DEFAULT_OFFLINE_TAKEOVER_THRESHOLD_MS = 15 * 60_000;

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

const peerRequestIntents = ["delegate"] as const;
export type PeerRequestIntent = (typeof peerRequestIntents)[number];

export function isPeerDelegationRequest(request: Pick<PeerRequestInput, "kind" | "intent">): boolean {
  return request.kind === "ops-request" && request.intent === "delegate";
}

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
  readonly intent?: PeerRequestIntent;
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

export interface StewardshipFenceInput {
  readonly executionId: string;
  readonly currentStewardshipEpoch: number;
  readonly currentStewardPersonId: string;
  readonly currentStewardNodeId?: string;
  readonly actingPersonId: string;
  readonly actingNodeId?: string;
  readonly expectedStewardshipEpoch?: number;
}

export type StewardshipFenceVerdict =
  | { readonly ok: true; readonly currentEpoch: number }
  | { readonly ok: false; readonly errorCode: "execution_handed_off"; readonly message: string };

/** Fence writes carrying a stale stewardshipEpoch or arriving from a superseded steward/node. */
export function assertExecutionStewardshipFence(input: StewardshipFenceInput): StewardshipFenceVerdict {
  const currentEpoch =
    Number.isSafeInteger(input.currentStewardshipEpoch) && input.currentStewardshipEpoch >= 1
      ? input.currentStewardshipEpoch
      : 1;
  if (
    input.expectedStewardshipEpoch !== undefined &&
    (!Number.isSafeInteger(input.expectedStewardshipEpoch) || input.expectedStewardshipEpoch < currentEpoch)
  ) {
    return {
      ok: false,
      errorCode: "execution_handed_off",
      message:
        `Execution ${input.executionId} has been handed off to stewardshipEpoch ${currentEpoch} ` +
        `(caller supplied stale epoch ${String(input.expectedStewardshipEpoch)}).`,
    };
  }
  if (currentEpoch > 1 && input.actingPersonId !== input.currentStewardPersonId) {
    return {
      ok: false,
      errorCode: "execution_handed_off",
      message:
        `Execution ${input.executionId} was handed off to ${input.currentStewardPersonId} ` +
        `at stewardshipEpoch ${currentEpoch}; writes from ${input.actingPersonId} are fenced.`,
    };
  }
  if (
    currentEpoch > 1 &&
    input.currentStewardNodeId !== undefined &&
    input.actingNodeId !== undefined &&
    input.actingNodeId !== input.currentStewardNodeId
  ) {
    return {
      ok: false,
      errorCode: "execution_handed_off",
      message:
        `Execution ${input.executionId} is stewarded by node ${input.currentStewardNodeId} ` +
        `at stewardshipEpoch ${currentEpoch}; writes from node ${input.actingNodeId} are fenced.`,
    };
  }
  return { ok: true, currentEpoch };
}

export interface OfflineTakeoverAdmissionInput {
  readonly fleetStreamConnected: boolean;
  readonly hasWritePermission: boolean;
  readonly holderNodeOnline: boolean;
  readonly disconnectedForMs: number | null;
  readonly takeoverThresholdMs?: number;
  readonly humanConfirmed: boolean;
}

export type OfflineTakeoverAdmissionVerdict =
  | { readonly allowed: true; readonly thresholdMs: number }
  | {
      readonly allowed: false;
      readonly errorCode:
        | "peer_replication_disconnected"
        | "authorization_missing"
        | "execution_holder_online"
        | "takeover_threshold_not_met"
        | "peer_local_human_confirmation_required";
      readonly message: string;
    };

/** Enforce offline takeover prerequisites: disconnected > threshold + repo write permission + local L1 confirmation. */
export function evaluateOfflineTakeoverAdmission(
  input: OfflineTakeoverAdmissionInput,
): OfflineTakeoverAdmissionVerdict {
  if (!input.fleetStreamConnected) {
    return {
      allowed: false,
      errorCode: "peer_replication_disconnected",
      message: "Fleet replication stream (7545) is disconnected; offline takeover fails closed until reconnected.",
    };
  }
  if (!input.hasWritePermission) {
    return {
      allowed: false,
      errorCode: "authorization_missing",
      message: "Offline takeover requires repository write permission from the center AuthorizationPort.",
    };
  }
  if (input.holderNodeOnline) {
    return {
      allowed: false,
      errorCode: "execution_holder_online",
      message:
        "The current steward node is still online; silent lock-stealing is forbidden. Request an explicit `ha peer handoff` instead.",
    };
  }
  const thresholdMs =
    input.takeoverThresholdMs !== undefined &&
    Number.isSafeInteger(input.takeoverThresholdMs) &&
    input.takeoverThresholdMs >= 0
      ? input.takeoverThresholdMs
      : DEFAULT_OFFLINE_TAKEOVER_THRESHOLD_MS;
  if (
    input.disconnectedForMs === null ||
    !Number.isFinite(input.disconnectedForMs) ||
    input.disconnectedForMs < thresholdMs
  ) {
    return {
      allowed: false,
      errorCode: "takeover_threshold_not_met",
      message:
        `Holder node disconnect duration (${input.disconnectedForMs ?? "unknown"}ms) has not exceeded ` +
        `the offline takeover threshold (${thresholdMs}ms).`,
    };
  }
  if (!input.humanConfirmed) {
    return {
      allowed: false,
      errorCode: "peer_local_human_confirmation_required",
      message: "Offline takeover requires explicit local human L1 confirmation (--human-confirmed).",
    };
  }
  return { allowed: true, thresholdMs };
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
    intent: { type: "string", enum: peerRequestIntents },
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

function relaxObjectSchema(node: EntityJsonObjectSchema): EntityJsonObjectSchema {
  return {
    ...node,
    additionalProperties: true,
    properties: Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => [key, relaxSchemaNode(value)]),
    ),
  };
}

function relaxSchemaNode(node: EntityJsonSchemaNode): EntityJsonSchemaNode {
  if (node.type === "object" && node.properties) return relaxObjectSchema(node);
  if (node.type === "array" && node.items) return { ...node, items: relaxSchemaNode(node.items) };
  return node;
}

function eventContractIssues(event: PeerRequestEventV1, allowUnknownFields = false): readonly string[] {
  const baseSchema: EntityJsonObjectSchema = objectFields({
    requestRevision: revisionField,
    ...peerPayloadFields[event.type],
  });
  const schema: EntityDocumentJsonSchema<unknown> = {
    $schema: schemaDialect,
    $id: "peer-request-event/v1",
    ...(allowUnknownFields ? relaxObjectSchema(baseSchema) : baseSchema),
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

export function isPeerRequestEvent(event: {
  readonly schema: string;
  readonly type: string;
}): event is PeerRequestEventV1 {
  return event.schema === "peer-request-event/v1" && isPeerRequestEventType(event.type);
}

export function peerRequestEventRequestId(event: PeerRequestEventV1): string {
  return event.type === "peer_request_opened" ? event.payload.request.requestId : event.payload.requestId;
}

export function isTerminalPeerRequestState(state: PeerRequestState): boolean {
  return state === "ANSWERED" || state === "DONE" || state === "REJECTED" || state === "PROMOTED";
}

export function validatePeerRequestEvent(value: unknown, allowUnknownFields = true): readonly string[] {
  if (!isRecord(value) || value.schema !== "peer-request-event/v1" || !isPeerRequestEventType(String(value.type)))
    return ["Invalid PeerRequest event schema or type."];
  const envelopeIssues = validateEventEnvelopeIdentity(value, allowUnknownFields);
  if (envelopeIssues.length > 0) return envelopeIssues;
  return eventContractIssues(value as unknown as PeerRequestEventV1, allowUnknownFields);
}

export function validateCurrentPeerRequestEvent(value: unknown): readonly string[] {
  return validatePeerRequestEvent(value, false);
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

export function peerRequestNextCursor(
  rows: readonly { readonly openedRevision: number }[],
  limit: number,
): string | null {
  return rows.length > limit ? String(rows[limit - 1]!.openedRevision) : null;
}

type PeerEventMeta = {
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly opId: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
};

function makePeerEnvelope<T extends PeerEventType>(
  type: T,
  meta: PeerEventMeta,
  payload: Extract<PeerRequestEventV1, { readonly type: T }>["payload"],
): Extract<PeerRequestEventV1, { readonly type: T }> {
  return { schema: "peer-request-event/v1", ...meta, type, payload } as Extract<
    PeerRequestEventV1,
    { readonly type: T }
  >;
}

export const compilePeerRequestOpened = (
  meta: PeerEventMeta,
  payload: Extract<PeerRequestEventV1, { readonly type: "peer_request_opened" }>["payload"],
) => makePeerEnvelope("peer_request_opened", meta, payload);
export const compilePeerRequestClaimed = (
  meta: PeerEventMeta,
  payload: Extract<PeerRequestEventV1, { readonly type: "peer_request_claimed" }>["payload"],
) => makePeerEnvelope("peer_request_claimed", meta, payload);
export const compilePeerRequestAnswered = (
  meta: PeerEventMeta,
  payload: Extract<PeerRequestEventV1, { readonly type: "peer_request_answered" }>["payload"],
) => makePeerEnvelope("peer_request_answered", meta, payload);
export const compilePeerRequestDone = (
  meta: PeerEventMeta,
  payload: Extract<PeerRequestEventV1, { readonly type: "peer_request_done" }>["payload"],
) => makePeerEnvelope("peer_request_done", meta, payload);
export const compilePeerRequestRejected = (
  meta: PeerEventMeta,
  payload: Extract<PeerRequestEventV1, { readonly type: "peer_request_rejected" }>["payload"],
) => makePeerEnvelope("peer_request_rejected", meta, payload);
export const compilePeerRequestPromoted = (
  meta: PeerEventMeta,
  payload: Extract<PeerRequestEventV1, { readonly type: "peer_request_promoted" }>["payload"],
) => makePeerEnvelope("peer_request_promoted", meta, payload);

const peerText = (field: string, required: boolean, flag?: string): EntityActionInputField => ({
  field,
  type: "string",
  required,
  ...(flag ? { cli: { name: flag, kind: "single", error: { code: "invalid_field" } } } : {}),
});
const peerFlagBool = (field: string, flag: string): EntityActionInputField => ({
  field,
  type: "boolean",
  required: false,
  cli: { name: flag, kind: "boolean", error: { code: "invalid_field" } },
});
const peerFlagNum = (field: string, flag: string): EntityActionInputField => ({
  field,
  type: "number",
  required: false,
  cli: { name: flag, kind: "single", error: { code: "invalid_field" }, projection: "number" },
});
const peerIdempotencyField = peerText("idempotencyKey", false, "--idempotency-key");
const peerRequestIdField = peerText("requestId", true);

export const peerActionDefinitions = [
  {
    id: "ask",
    read: false,
    summary: "Send a structured PeerRequest to another principal with atomic Inbox wakeup.",
    fields: [
      peerText("toPersonId", true, "--to"),
      peerText("summary", true, "--summary"),
      peerText("claim", true, "--claim"),
      peerText("requestedAction", true, "--action"),
      peerText("requestKind", false, "--kind"),
      peerText("workId", false, "--work"),
      peerText("lane", false, "--lane"),
      peerText("anchorRef", false, "--anchor-ref"),
      peerText("rootCause", false, "--root-cause"),
      peerText("verification", false, "--verification"),
      peerText("fromPersonId", false, "--from-person-id"),
      peerText("nodeId", false, "--node-id"),
      peerText("sessionHint", false, "--session-hint"),
      peerIdempotencyField,
    ],
  },
  {
    id: "reply",
    read: false,
    summary: "Reply to, complete, or reject a PeerRequest under Tier-A authorization ceilings.",
    fields: [
      peerRequestIdField,
      peerText("claim", false, "--claim"),
      peerText("requestedAction", false, "--action"),
      peerText("outcome", false, "--outcome"),
      peerText("reason", false, "--reason"),
      peerText("operation", false, "--operation"),
      peerFlagBool("preflightPassed", "--preflight-passed"),
      peerFlagBool("humanConfirmed", "--human-confirmed"),
      peerFlagBool("draftOnly", "--draft-only"),
      peerText("rootCause", false, "--root-cause"),
      peerText("verification", false, "--verification"),
      peerIdempotencyField,
    ],
  },
  {
    id: "watch",
    read: true,
    summary: "Wait for causally ready interactive_watch PeerRequest or reply frames for this principal.",
    fields: [
      peerFlagBool("once", "--once"),
      peerText("workId", false, "--work"),
      peerText("replyTo", false, "--reply-to"),
      peerText("lane", false, "--lane"),
      peerFlagNum("timeoutMs", "--timeout-ms"),
    ],
  },
  {
    id: "inbox",
    read: true,
    summary: "List interactive_watch peer Inbox items and PeerRequest snapshots for this principal.",
    fields: [
      peerText("state", false, "--state"),
      peerText("requestKind", false, "--kind"),
      peerText("workId", false, "--work"),
      peerText("lane", false, "--lane"),
      peerFlagBool("sent", "--sent"),
      peerFlagNum("limit", "--limit"),
    ],
  },
  {
    id: "promote",
    read: false,
    summary: "Promote a PeerRequest into a formal HA task under an existing work atomically.",
    fields: [
      peerRequestIdField,
      peerText("work", true, "--work"),
      peerText("title", false, "--title"),
      peerIdempotencyField,
    ],
  },
  {
    id: "handoff",
    read: false,
    summary: "Bundle local WIP state and receipts into a ContinuationPacket and hand off to a peer CEO.",
    fields: [
      peerText("targetId", true),
      peerText("toPersonId", true, "--to"),
      peerText("summary", false, "--summary"),
      peerText("nextAction", false, "--next-action"),
      peerText("blockingGate", false, "--blocking-gate"),
      peerFlagNum("prNumber", "--pr-number"),
      peerText("workId", false, "--work"),
      peerText("lane", false, "--lane"),
      peerText("wipCommitSha", false, "--wip-commit-sha"),
      peerText("bundlePath", false, "--bundle-path"),
      peerText("fromPersonId", false, "--from-person-id"),
      peerText("nodeId", false, "--node-id"),
      peerIdempotencyField,
    ],
  },
  {
    id: "accept-handoff",
    read: false,
    summary: "Atomically transfer an active Execution lease and stewardshipEpoch from a peer handoff request.",
    fields: [
      peerRequestIdField,
      peerText("nodeId", false, "--node-id"),
      peerFlagBool("materializeWorktree", "--materialize-worktree"),
      peerFlagNum("ttlMs", "--ttl-ms"),
      peerIdempotencyField,
    ],
  },
  {
    id: "takeover",
    read: false,
    summary:
      "Force-takeover an active Execution from a disconnected node with stewardshipEpoch fencing and L1 confirmation.",
    fields: [
      peerText("targetId", true),
      peerText("reason", true, "--reason"),
      peerFlagBool("humanConfirmed", "--human-confirmed"),
      peerText("nodeId", false, "--node-id"),
      peerFlagNum("thresholdMs", "--threshold-ms"),
      peerFlagNum("ttlMs", "--ttl-ms"),
      peerIdempotencyField,
    ],
  },
  {
    id: "checkpoint",
    read: false,
    summary:
      "Record a lightweight milestone WIP commit/bundle checkpoint on an active Execution under stewardshipEpoch fencing.",
    fields: [
      peerText("targetId", true),
      peerText("wipCommitSha", false, "--wip-commit-sha"),
      peerText("bundlePath", false, "--bundle-path"),
      peerText("receiptRef", false, "--receipt-ref"),
      peerFlagNum("stewardshipEpoch", "--stewardship-epoch"),
      peerText("nodeId", false, "--node-id"),
      peerIdempotencyField,
    ],
  },
] as const;

export function createPeerActionCatalog(baseAction: (id: string) => EntityActionContract) {
  return {
    ref: "kernel/peer-action/v1",
    actions: peerActionDefinitions.map(
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
          artifactOwnership: { owner: "peer-request/{id}", path: "peer-requests/{id}.json" },
        },
        effects: read ? [] : [{ ref: "peer_request_opened", projection: "peer-request/v1" }],
        execution: {
          ingress: `peer-${id}`,
          compile: null,
          read,
          implementation: "catalog-runtime",
          topology: "center-forward-write",
          targetIdField: id === "handoff" || id === "takeover" || id === "checkpoint" ? "targetId" : "requestId",
        },
      }),
    ),
  };
}

/** PeerRequestV1 ontology declarations (dec_2B573FD17D82C9ADDE2FC69C5D CH2/CH3/CH4). */
export const peerJudgments = [
  {
    id: "authenticated-sender",
    symbol: "packages/kernel/src/domain/peer-collaboration.ts#verifyPeerSenderIdentity",
    inputs: ["claimed person id", "authenticated person id"],
    output: "Peer sender identity result",
    failureCodes: ["peer_sender_spoofing_denied"],
    explain: "Bind the claimed sender to the principal authenticated by the center.",
    consumers: ["packages/kernel/src/domain/peer-collaboration.ts", "packages/daemon/src/daemon-host/peer-action.ts"],
    sources: [],
  },
  {
    id: "peer-request-event-validation",
    symbol: "packages/kernel/src/domain/peer-collaboration.ts#validatePeerRequestEvent",
    inputs: ["unknown canonical peer request event"],
    output: "readonly string[] validation issues",
    failureCodes: ["peer_request_invalid_input"],
    explain: "Validate canonical peer-request-event/v1 envelopes and payloads before admission.",
    consumers: [],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#validatePeerRequestEvent:57ccd6886015e975aaa0ce75d002f61d",
        route: "validatePeerRequestEvent",
      },
    ],
  },
  {
    id: "stewardship-epoch-fence",
    symbol: "packages/kernel/src/domain/peer-collaboration.ts#assertExecutionStewardshipFence",
    inputs: ["execution stewardship epoch, steward identity, acting principal/node, expected epoch"],
    output: "StewardshipFenceVerdict",
    failureCodes: ["execution_handed_off"],
    explain: "Fence execution writes carrying a stale stewardshipEpoch or arriving from a superseded steward/node.",
    consumers: ["packages/daemon/src/daemon-host/peer-action.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#assertExecutionStewardshipFence:ccaa947cec8dddfc2b958059f897292d",
        route: "assertExecutionStewardshipFence",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];

export const peerPolicies = [
  {
    id: "execution-ceiling",
    ownerRef: "peer-request",
    unit: "Tier A operation",
    bounds:
      "L0 is read-only. L1 requires local preflight and local human confirmation. L2 and unknown operations are draft-only.",
    defaultValue: "draft_only",
    version: 1,
    scope: "Receiver-side evaluation of untrusted peer intent",
    reason: "A remote request cannot delegate the receiving principal's authority.",
    fixtures: ["packages/kernel/test/peer-collaboration.test.ts", "packages/daemon/test/peer-collaboration.test.ts"],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#evaluatePeerExecutionCeiling.tier:1aa4cf7aa9729a9ae689d62ff902fa74",
        route: "evaluatePeerExecutionCeiling",
      },
    ],
  },
  {
    id: "claim-fence",
    ownerRef: "peer-request",
    unit: "request claim",
    bounds:
      "A terminal event requires a live claim owned by the recipient and must present its fence. Reclaim is available at expiry.",
    defaultValue: null,
    version: 1,
    scope: "PeerRequest lifecycle",
    reason: "A window that loses its claim cannot settle the request after takeover.",
    fixtures: ["packages/kernel/test/peer-collaboration.test.ts", "packages/daemon/test/peer-collaboration.test.ts"],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#peerRequestV1JsonSchema.claim:02c52e58cabf7ab5083a713eb26afc70",
        route: "PeerRequestV1 claim schema",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#reducePeerRequestEvent:49adb3c8f0bf4390ec0d6b480bbf3670",
        route: "reducePeerRequestEvent",
      },
    ],
  },
  {
    id: "peer-collaboration-bridge",
    ownerRef: "peer-request",
    unit: "items / ms",
    bounds:
      "Peer reads cap at 200 items per page, peer inbox wakes use dispatchable/interactive_watch admission, and handoff git bundle subprocesses enforce bounded 5s/15s timeouts.",
    defaultValue: 200,
    version: 1,
    scope: "PeerRequest projection reads, daemon ha peer actions, and handoff bundle packaging",
    reason:
      "Keep every peer bridge read bounded, isolated to interactive_watch, and protected against hung git subprocesses.",
    fixtures: [
      "packages/storage/test/store/peer-request-projection.test.ts",
      "packages/daemon/test/peer-collaboration.test.ts",
    ],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#PEER_REQUEST_PAGE_LIMIT:e654af11f2334d49dbdfaa7d6d5ebe49",
        route: "readPeerRequests",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#evaluatePeerWatchOnce.read.limit:bf38217595aafee0d2b364031d7e7000",
        route: "peer-watch",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.reqRead:4dc0fc48e6ccdf43448f986242d28462",
        route: "peer-inbox",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.inboxRead:78f06c4227ba785282a4e80f837cbc12",
        route: "peer-inbox",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.inboxBundle.payload.admission:0434b29be0266d9440715451ee9874bd",
        route: "peer-ask",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.payload.admission:0434b29be0266d9440715451ee9874bd",
        route: "peer-reply",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-handoff-bundle.ts#prepareHandoffBundle.rev.timeoutMs:08b0a8a64d90c6ee0feb0e9b7d52b2ae",
        route: "peer-handoff",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-handoff-bundle.ts#prepareHandoffBundle.created.timeoutMs:08ce959d3673db2be6251563546f9a16",
        route: "peer-handoff",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-handoff-bundle.ts#materializeHandoffBundle.unbundled.timeoutMs:08ce959d3673db2be6251563546f9a16",
        route: "peer-accept-handoff",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.payload.admission:0434b29be0266d9440715451ee9874bd:2",
        route: "peer-accept-handoff",
      },
    ],
  },
  {
    id: "execution-stewardship-takeover",
    ownerRef: "peer-request",
    unit: "epoch / ms",
    bounds:
      "Execution stewardshipEpoch starts at 1 and increments monotonically on accept-handoff or offline takeover; offline takeover requires 7545 connectivity, repository write permission, holder node disconnected past threshold (default 15m), and local human L1 confirmation.",
    defaultValue: 900000,
    version: 1,
    scope: "Cross-principal Execution lease transfer, offline takeover admission, and stewardshipEpoch validation",
    reason:
      "Prevent silent lock-stealing against online peers and guarantee split-brain writes from awakened offline nodes fail with execution_handed_off.",
    fixtures: ["packages/kernel/test/peer-collaboration.test.ts", "packages/daemon/test/peer-collaboration.test.ts"],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#evaluateOfflineTakeoverAdmission.allowed:f0ce3ef598574b1ebe708af042563f87",
        route: "evaluateOfflineTakeoverAdmission",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#evaluateOfflineTakeoverAdmission.allowed:f0ce3ef598574b1ebe708af042563f87:2",
        route: "evaluateOfflineTakeoverAdmission",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#evaluateOfflineTakeoverAdmission.allowed:f0ce3ef598574b1ebe708af042563f87:3",
        route: "evaluateOfflineTakeoverAdmission",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#evaluateOfflineTakeoverAdmission.thresholdMs:f51277016dd7398e0d3acc9349ad7d60",
        route: "evaluateOfflineTakeoverAdmission",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#evaluateOfflineTakeoverAdmission.allowed:f0ce3ef598574b1ebe708af042563f87:4",
        route: "evaluateOfflineTakeoverAdmission",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#evaluateOfflineTakeoverAdmission.allowed:f0ce3ef598574b1ebe708af042563f87:5",
        route: "evaluateOfflineTakeoverAdmission",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#evaluateOfflineTakeoverAdmission.allowed:d3583fbbe4fa23918ff42c68ae84c60d",
        route: "evaluateOfflineTakeoverAdmission",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.nextLease:6dcd9900c158a24ed0ed384556c97b6f",
        route: "peer-accept-handoff",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.disconnectedForMs:430b5e30bdc598adebcc33350138ca3c",
        route: "peer-takeover",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.verdict:d3a415759adc1ecd048a0df4c51f5b7e",
        route: "peer-takeover",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.nextLease:894af39d3a83fe4b1775457b54032feb",
        route: "peer-takeover",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/execution.ts#validateExecutionV1:acc96a411afd684183141c7e2b4b0d70",
        route: "validateExecutionV1",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/execution.ts#validateLeaseV1:29eadbf262d72397fa66f914f416ecad",
        route: "validateLeaseV1",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-event.ts#validateTaskEventFields:69081aa1d8594a46bc2fae95207c6bd4",
        route: "validateTaskEventFields",
      },
    ],
  },
] as const satisfies readonly OntologyPolicyDeclaration[];
