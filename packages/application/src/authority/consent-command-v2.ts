import { consentActions, type ConsentAction } from "../../../kernel/src/index.ts";
import { canonicalPayloadDigestV2 } from "./fact-relation-command-v2.ts";
import {
  bytesEqual,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";
import {
  exactSemanticObjectV2,
  semanticAdmissionV2,
  semanticStringValueV2
} from "./semantic-authority-helpers-v2.ts";

export const consentTypedCommandsV2 = ["consent.grant", "consent.consume", "consent.expire"] as const;
export type ConsentTypedCommandV2 = (typeof consentTypedCommandsV2)[number];

export interface ConsentReviewInputV2 {
  readonly reviewId: string;
  readonly findings: string;
  readonly evidenceChecked: ReadonlyArray<string>;
  readonly rationale: string;
  readonly archiveWarningsAcknowledged: boolean;
}

export type ConsentGrantPayloadV2 = {
  readonly schema: "consent.grant/v1";
  readonly taskId: string;
  readonly executionId: string;
  readonly consentId: string;
  readonly utterance: string;
  readonly actions: ReadonlyArray<ConsentAction>;
};

export type ConsentConsumePayloadV2 = {
  readonly schema: "consent.consume/v1";
  readonly taskId: string;
  readonly executionId: string;
  readonly consentId: string;
  readonly utterance: string | null;
  readonly actions: ReadonlyArray<ConsentAction>;
  readonly review: ConsentReviewInputV2;
};

export type ConsentExpirePayloadV2 = {
  readonly schema: "consent.expire/v1";
  readonly taskId: string;
  readonly consentId: string;
};

export type ConsentCommandPayloadV2 = ConsentGrantPayloadV2 | ConsentConsumePayloadV2 | ConsentExpirePayloadV2;

export function decodeConsentCommandPayloadV2(envelope: SemanticMutationEnvelopeV2): {
  readonly payload: ConsentCommandPayloadV2;
  readonly decodedBytes: bigint;
} {
  if (envelope.intent.kind !== "typed") throw semanticAdmissionV2("SEMANTIC_DIFF_REQUIRED");
  if (envelope.intent.command.registryVersion !== 1 || envelope.intent.command.version !== 1) {
    throw semanticAdmissionV2("TYPED_COMMAND_VERSION_UNSUPPORTED");
  }
  if (!consentTypedCommandsV2.includes(envelope.intent.command.name as ConsentTypedCommandV2)) {
    throw semanticAdmissionV2("TYPED_COMMAND_UNREGISTERED");
  }
  if (envelope.intent.canonicalPayload.kind !== "inline") throw semanticAdmissionV2("AUTHORITY_PAYLOAD_CAS_UNSUPPORTED");
  const bytes = envelope.intent.canonicalPayload.bytes;
  if (envelope.intent.canonicalPayload.size !== BigInt(bytes.length)) throw semanticAdmissionV2("CANONICAL_PAYLOAD_SIZE_MISMATCH");
  if (!bytesEqual(envelope.intent.canonicalPayloadDigest, canonicalPayloadDigestV2(bytes))) {
    throw semanticAdmissionV2("CANONICAL_PAYLOAD_DIGEST_MISMATCH");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  }
  const payload = decodeStrictConsentPayloadV2(decoded);
  if (!bytesEqual(bytes, encodeConsentCommandPayloadV2(payload))) {
    throw semanticAdmissionV2("TYPED_PAYLOAD_NON_CANONICAL");
  }
  if (payload.schema.replace("/v1", "") !== envelope.intent.command.name) {
    throw semanticAdmissionV2("TYPED_COMMAND_PAYLOAD_MISMATCH");
  }
  return { payload, decodedBytes: BigInt(bytes.length) };
}

export function encodeConsentCommandPayloadV2(payload: ConsentCommandPayloadV2): Uint8Array {
  return Buffer.from(JSON.stringify(canonicalizeConsentCommandJsonV2(payload)), "utf8");
}

function decodeStrictConsentPayloadV2(value: unknown): ConsentCommandPayloadV2 {
  const discriminator = exactSemanticObjectV2(value, ["schema"], { allowAdditional: true });
  if (discriminator.schema === "consent.grant/v1") {
    const row = exactSemanticObjectV2(value, ["schema", "taskId", "executionId", "consentId", "utterance", "actions"]);
    return {
      schema: discriminator.schema,
      taskId: consentCommandTextV2(row.taskId),
      executionId: consentCommandTextV2(row.executionId),
      consentId: consentCommandTextV2(row.consentId),
      utterance: consentCommandTextV2(row.utterance),
      actions: consentCommandActionsV2(row.actions)
    };
  }
  if (discriminator.schema === "consent.consume/v1") {
    const row = exactSemanticObjectV2(value, ["schema", "taskId", "executionId", "consentId", "utterance", "actions", "review"]);
    return {
      schema: discriminator.schema,
      taskId: consentCommandTextV2(row.taskId),
      executionId: consentCommandTextV2(row.executionId),
      consentId: consentCommandTextV2(row.consentId),
      utterance: row.utterance === null ? null : consentCommandTextV2(row.utterance),
      actions: consentCommandActionsV2(row.actions),
      review: consentReviewInputV2(row.review)
    };
  }
  if (discriminator.schema === "consent.expire/v1") {
    const row = exactSemanticObjectV2(value, ["schema", "taskId", "consentId"]);
    return {
      schema: discriminator.schema,
      taskId: consentCommandTextV2(row.taskId),
      consentId: consentCommandTextV2(row.consentId)
    };
  }
  throw semanticAdmissionV2("TYPED_PAYLOAD_SCHEMA_UNSUPPORTED");
}

function consentReviewInputV2(value: unknown): ConsentReviewInputV2 {
  const row = exactSemanticObjectV2(value, ["reviewId", "findings", "evidenceChecked", "rationale", "archiveWarningsAcknowledged"]);
  if (typeof row.archiveWarningsAcknowledged !== "boolean") throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  return {
    reviewId: consentCommandTextV2(row.reviewId),
    findings: consentCommandTextV2(row.findings),
    evidenceChecked: consentCommandStringArrayV2(row.evidenceChecked),
    rationale: consentCommandTextV2(row.rationale),
    archiveWarningsAcknowledged: row.archiveWarningsAcknowledged
  };
}

function consentCommandActionsV2(value: unknown): ReadonlyArray<ConsentAction> {
  const actions = consentCommandStringArrayV2(value);
  if (actions.some((action) => !consentActions.includes(action as ConsentAction))) {
    throw semanticAdmissionV2("CONSENT_ACTION_UNSUPPORTED");
  }
  return actions as ReadonlyArray<ConsentAction>;
}

function consentCommandStringArrayV2(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  return value.map(consentCommandTextV2);
}

function consentCommandTextV2(value: unknown): string {
  const result = semanticStringValueV2(value);
  if (!result || result.trim() !== result) throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  return result;
}

function canonicalizeConsentCommandJsonV2(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeConsentCommandJsonV2);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalizeConsentCommandJsonV2(entry)]));
}
