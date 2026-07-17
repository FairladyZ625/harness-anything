import { Schema } from "effect";
import {
  entityRegistry,
  executionDeclaration,
  reviewDeclaration,
  type ExecutionRecord,
  type ReviewRecord,
  type SessionManifest
} from "../../../kernel/src/index.ts";
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

export const sessionExecutionReviewTypedCommandsV2 = [
  "session.export",
  "session.sync",
  "session.archive",
  "execution.claim",
  "execution.submit",
  "execution.close",
  "review.create",
  "review.dismiss",
  "review.record"
] as const;

export type SessionExecutionReviewTypedCommandV2 = (typeof sessionExecutionReviewTypedCommandsV2)[number];

export type SessionActionPayloadV2 = {
  readonly schema: "session.export/v1" | "session.sync/v1" | "session.archive/v1";
  readonly manifest: SessionManifest;
  readonly body: string;
};

export type ExecutionActionPayloadV2 = {
  readonly schema: "execution.claim/v1" | "execution.submit/v1" | "execution.close/v1";
  readonly taskId: string;
  readonly execution: ExecutionRecord;
  readonly taskIndexBody?: string;
};

export type ReviewActionPayloadV2 = {
  readonly schema: "review.create/v1" | "review.dismiss/v1" | "review.record/v1";
  readonly taskId: string;
  readonly review: ReviewRecord;
};

export type SessionExecutionReviewCommandPayloadV2 =
  | SessionActionPayloadV2
  | ExecutionActionPayloadV2
  | ReviewActionPayloadV2;

export function decodeSessionExecutionReviewCommandPayloadV2(envelope: SemanticMutationEnvelopeV2): {
  readonly payload: SessionExecutionReviewCommandPayloadV2;
  readonly decodedBytes: bigint;
} {
  if (envelope.intent.kind !== "typed") throw semanticAdmissionV2("SEMANTIC_DIFF_REQUIRED");
  if (envelope.intent.command.registryVersion !== 1 || envelope.intent.command.version !== 1) {
    throw semanticAdmissionV2("TYPED_COMMAND_VERSION_UNSUPPORTED");
  }
  if (!sessionExecutionReviewTypedCommandsV2.includes(envelope.intent.command.name as SessionExecutionReviewTypedCommandV2)) {
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
  const payload = decodeStrictSessionExecutionReviewPayloadV2(decoded);
  if (!bytesEqual(bytes, encodeSessionExecutionReviewCommandPayloadV2(payload))) {
    throw semanticAdmissionV2("TYPED_PAYLOAD_NON_CANONICAL");
  }
  if (payload.schema.replace("/v1", "") !== envelope.intent.command.name) {
    throw semanticAdmissionV2("TYPED_COMMAND_PAYLOAD_MISMATCH");
  }
  return { payload, decodedBytes: BigInt(bytes.length) };
}

export function encodeSessionExecutionReviewCommandPayloadV2(
  payload: SessionExecutionReviewCommandPayloadV2
): Uint8Array {
  return Buffer.from(JSON.stringify(canonicalJsonValue(payload)), "utf8");
}

function decodeStrictSessionExecutionReviewPayloadV2(value: unknown): SessionExecutionReviewCommandPayloadV2 {
  const discriminator = exactSemanticObjectV2(value, ["schema"], { allowAdditional: true });
  switch (discriminator.schema) {
    case "session.export/v1":
    case "session.sync/v1":
    case "session.archive/v1": {
      const row = exactSemanticObjectV2(value, ["schema", "manifest", "body"]);
      return {
        schema: discriminator.schema,
        manifest: decodeSessionManifest(row.manifest),
        body: semanticStringValueV2(row.body)
      };
    }
    case "execution.claim/v1":
    case "execution.submit/v1":
    case "execution.close/v1": {
      const row = exactSemanticObjectV2(value, ["schema", "taskId", "execution"], { allowAdditional: true });
      const actual = Object.keys(row);
      if (actual.some((key) => !["schema", "taskId", "execution", "taskIndexBody"].includes(key))) {
        throw semanticAdmissionV2("TYPED_PAYLOAD_UNKNOWN_OR_MISSING_FIELD");
      }
      return {
        schema: discriminator.schema,
        taskId: nonBlankText(row.taskId),
        execution: decodeExecution(row.execution),
        ...(row.taskIndexBody === undefined ? {} : { taskIndexBody: semanticStringValueV2(row.taskIndexBody) })
      };
    }
    case "review.create/v1":
    case "review.dismiss/v1":
    case "review.record/v1": {
      const row = exactSemanticObjectV2(value, ["schema", "taskId", "review"]);
      return {
        schema: discriminator.schema,
        taskId: nonBlankText(row.taskId),
        review: decodeReview(row.review)
      };
    }
    default:
      throw semanticAdmissionV2("TYPED_PAYLOAD_SCHEMA_UNSUPPORTED");
  }
}

function decodeSessionManifest(value: unknown): SessionManifest {
  try {
    return Schema.decodeUnknownSync(entityRegistry.session.schema)(value) as SessionManifest;
  } catch {
    throw semanticAdmissionV2("SESSION_MANIFEST_INVALID");
  }
}

function decodeExecution(value: unknown): ExecutionRecord {
  try {
    return Schema.decodeUnknownSync(executionDeclaration.schema)(value) as ExecutionRecord;
  } catch {
    throw semanticAdmissionV2("EXECUTION_DOCUMENT_INVALID");
  }
}

function decodeReview(value: unknown): ReviewRecord {
  try {
    return Schema.decodeUnknownSync(reviewDeclaration.schema)(value) as ReviewRecord;
  } catch {
    throw semanticAdmissionV2("REVIEW_DOCUMENT_INVALID");
  }
}

function nonBlankText(value: unknown): string {
  const result = semanticStringValueV2(value);
  if (!result || result.trim() !== result) throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  return result;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
}
