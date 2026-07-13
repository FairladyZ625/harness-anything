import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  FactRecordSchema,
  entityRegistry,
  type EntityRelationRecord,
  type FactConfidence,
  type FactMemoryClass,
  type FactMemoryTag,
  type FactRecord,
  type ProvenancePayload
} from "../../../kernel/src/index.ts";
import {
  SemanticAdmissionErrorV2,
  bytesEqual,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";
import {
  exactSemanticObjectV2,
  semanticAdmissionV2
} from "./semantic-authority-helpers-v2.ts";

export const factRelationTypedCommandsV2 = [
  "fact.create",
  "fact.invalidate",
  "relation.create",
  "relation.retire",
  "relation.replace"
] as const;

export type FactRelationTypedCommandV2 = (typeof factRelationTypedCommandsV2)[number];

export type FactRelationCommandPayloadV2 =
  | FactCreatePayloadV2
  | FactInvalidatePayloadV2
  | RelationCreatePayloadV2
  | RelationRetirePayloadV2
  | RelationReplacePayloadV2;

export interface FactCreatePayloadV2 {
  readonly schema: "fact.create/v1";
  readonly ownerTaskId: string;
  readonly factId: string;
  readonly statement: string;
  readonly source: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly memoryClass: FactMemoryClass;
  readonly memoryTags: ReadonlyArray<FactMemoryTag>;
  readonly provenance: ReadonlyArray<ProvenancePayload>;
}

export interface FactInvalidatePayloadV2 {
  readonly schema: "fact.invalidate/v1";
  readonly ownerTaskId: string;
  readonly factId: string;
  readonly invalidatedByFactId: string;
  readonly rationale: string;
}

export interface RelationCreatePayloadV2 {
  readonly schema: "relation.create/v1";
  readonly relation: EntityRelationRecord;
}

export interface RelationRetirePayloadV2 {
  readonly schema: "relation.retire/v1";
  readonly sourceRef: string;
  readonly relationId: string;
}

export interface RelationReplacePayloadV2 {
  readonly schema: "relation.replace/v1";
  readonly sourceRef: string;
  readonly relationId: string;
  readonly replacement: EntityRelationRecord;
}

const blobDigestDomain = Buffer.from("ha/blob/v1\0", "utf8");

export function decodeFactRelationCommandPayloadV2(envelope: SemanticMutationEnvelopeV2): {
  readonly payload: FactRelationCommandPayloadV2;
  readonly decodedBytes: bigint;
} {
  if (envelope.intent.kind !== "typed") throw semanticAdmissionV2("TYPED_COMMAND_REQUIRED");
  if (envelope.intent.command.registryVersion !== 1 || envelope.intent.command.version !== 1) {
    throw semanticAdmissionV2("TYPED_COMMAND_VERSION_UNSUPPORTED");
  }
  if (!factRelationTypedCommandsV2.includes(envelope.intent.command.name as FactRelationTypedCommandV2)) {
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
  const payload = decodeStrictFactRelationPayloadV2(decoded);
  if (!bytesEqual(bytes, encodeFactRelationCommandPayloadV2(payload))) throw semanticAdmissionV2("TYPED_PAYLOAD_NON_CANONICAL");
  if (payload.schema.replace("/v1", "") !== envelope.intent.command.name) throw semanticAdmissionV2("TYPED_COMMAND_PAYLOAD_MISMATCH");
  return { payload, decodedBytes: BigInt(bytes.length) };
}

export function encodeFactRelationCommandPayloadV2(payload: FactRelationCommandPayloadV2): Uint8Array {
  return Buffer.from(JSON.stringify(canonicalPayloadWire(payload)), "utf8");
}

export function canonicalPayloadDigestV2(bytes: Uint8Array): Uint8Array {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  return createHash("sha256").update(blobDigestDomain).update(size).update(bytes).digest();
}

export function decodeFactRecordV2(value: unknown): FactRecord {
  try {
    return Schema.decodeUnknownSync(FactRecordSchema)({ schema: "fact-record/v1", ...(value as object) });
  } catch {
    throw semanticAdmissionV2("FACT_PAYLOAD_INVALID");
  }
}

export function decodeRelationV2(value: unknown): EntityRelationRecord {
  try {
    const row = exactSemanticObjectV2(value, ["relation_id", "source", "target", "type", "strength", "direction", "origin", "rationale", "state"], { name: "relation" });
    return Schema.decodeUnknownSync(entityRegistry.relation.schema)(row);
  } catch (error) {
    if (error instanceof SemanticAdmissionErrorV2) throw error;
    throw semanticAdmissionV2("RELATION_PAYLOAD_INVALID");
  }
}

function canonicalPayloadWire(payload: FactRelationCommandPayloadV2): object {
  switch (payload.schema) {
    case "fact.create/v1":
      return {
        schema: payload.schema,
        ownerTaskId: payload.ownerTaskId,
        factId: payload.factId,
        statement: payload.statement,
        source: payload.source,
        observedAt: payload.observedAt,
        confidence: payload.confidence,
        memoryClass: payload.memoryClass,
        memoryTags: [...payload.memoryTags],
        provenance: payload.provenance.map((entry) => ({
          runtime: entry.runtime,
          sessionId: entry.sessionId,
          boundAt: entry.boundAt
        }))
      };
    case "fact.invalidate/v1":
      return {
        schema: payload.schema,
        ownerTaskId: payload.ownerTaskId,
        factId: payload.factId,
        invalidatedByFactId: payload.invalidatedByFactId,
        rationale: payload.rationale
      };
    case "relation.create/v1":
      return { schema: payload.schema, relation: canonicalRelationWire(payload.relation) };
    case "relation.retire/v1":
      return { schema: payload.schema, sourceRef: payload.sourceRef, relationId: payload.relationId };
    case "relation.replace/v1":
      return {
        schema: payload.schema,
        sourceRef: payload.sourceRef,
        relationId: payload.relationId,
        replacement: canonicalRelationWire(payload.replacement)
      };
  }
}

function canonicalRelationWire(relation: EntityRelationRecord): object {
  return {
    relation_id: relation.relation_id,
    source: relation.source,
    target: relation.target,
    type: relation.type,
    strength: relation.strength,
    direction: relation.direction,
    origin: relation.origin,
    rationale: relation.rationale,
    state: relation.state
  };
}

function decodeStrictFactRelationPayloadV2(value: unknown): FactRelationCommandPayloadV2 {
  const row = exactSemanticObjectV2(value, ["schema"], { name: "typed payload", allowAdditional: true });
  switch (row.schema) {
    case "fact.create/v1":
      return exactSemanticObjectV2(value, ["schema", "ownerTaskId", "factId", "statement", "source", "observedAt", "confidence", "memoryClass", "memoryTags", "provenance"], { name: row.schema }) as unknown as FactCreatePayloadV2;
    case "fact.invalidate/v1":
      return exactSemanticObjectV2(value, ["schema", "ownerTaskId", "factId", "invalidatedByFactId", "rationale"], { name: row.schema }) as unknown as FactInvalidatePayloadV2;
    case "relation.create/v1": {
      const payload = exactSemanticObjectV2(value, ["schema", "relation"], { name: row.schema });
      return { schema: row.schema, relation: decodeRelationV2(payload.relation) };
    }
    case "relation.retire/v1":
      return exactSemanticObjectV2(value, ["schema", "sourceRef", "relationId"], { name: row.schema }) as unknown as RelationRetirePayloadV2;
    case "relation.replace/v1": {
      const payload = exactSemanticObjectV2(value, ["schema", "sourceRef", "relationId", "replacement"], { name: row.schema });
      return {
        schema: row.schema,
        sourceRef: payloadText(payload.sourceRef),
        relationId: payloadText(payload.relationId),
        replacement: decodeRelationV2(payload.replacement)
      };
    }
    default:
      throw semanticAdmissionV2("TYPED_PAYLOAD_SCHEMA_UNSUPPORTED");
  }
}

function payloadText(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value) throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  return value;
}
