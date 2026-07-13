import { Schema } from "effect";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import { WriteAttributionSchema, type WriteAttribution } from "../schemas/actor-attribution.ts";
import { rejectWrite } from "./write-journal-rejection.ts";
import { writePayloadRef } from "./write-journal-durable.ts";
import type {
  JournalActor,
  JournalRecordKind,
  JournalRecordV1,
  JournalRecordV2,
  OperationalActor,
  ReadableJournalRecord
} from "./write-journal-types.ts";

interface JournalRecordInput {
  readonly opId: string;
  readonly entityId: ReadableJournalRecord["entityId"];
  readonly kind: JournalRecordKind;
  readonly payload?: unknown;
  readonly authorityIntegrity?: WriteOp["authorityIntegrity"];
}

export function decodeWriteAttribution(value: unknown, entityId?: ReadableJournalRecord["entityId"]): WriteAttribution {
  try {
    return Schema.decodeUnknownSync(WriteAttributionSchema)(value);
  } catch {
    rejectWrite("write coordinator requires valid principal attribution", entityId);
  }
}

export function createAttributedJournalRecord(
  rootDir: string,
  journalPath: string,
  op: JournalRecordInput,
  attribution: WriteAttribution
): JournalRecordV2 {
  const payload = journalPayload(op);
  return {
    schema: "write-journal/v2",
    opId: op.opId,
    entityId: op.entityId,
    kind: op.kind,
    actor: attribution.actor,
    principalSource: attribution.principalSource,
    executorSource: attribution.executorSource,
    at: new Date().toISOString(),
    ...(op.authorityIntegrity ? { authorityIntegrity: op.authorityIntegrity } : {}),
    payloadRef: writePayloadRef(rootDir, journalPath, op.opId, payload),
    payload: { payloadHash: stablePayloadHash(payload) }
  };
}

// Operational machine artifacts remain on their pre-Phase-3 WAL envelope until
// runtime-event convergence. They never receive a fabricated business principal.
export function createOperationalJournalRecord(
  rootDir: string,
  journalPath: string,
  op: JournalRecordInput,
  actor: OperationalActor
): JournalRecordV1 {
  const payload = journalPayload(op);
  return {
    schema: "write-journal/v1",
    opId: op.opId,
    entityId: op.entityId,
    kind: op.kind,
    actor: { kind: actor.kind, id: actor.id },
    at: new Date().toISOString(),
    ...(op.authorityIntegrity ? { authorityIntegrity: op.authorityIntegrity } : {}),
    payloadRef: writePayloadRef(rootDir, journalPath, op.opId, payload),
    payload: { payloadHash: stablePayloadHash(payload) }
  };
}

export function assertRecordMatchesAttributedOp(
  record: ReadableJournalRecord,
  op: JournalRecordInput,
  attribution: WriteAttribution
): void {
  if (record.schema !== "write-journal/v2" || recordFingerprint(record) !== inputFingerprint(op, attribution)) {
    collision(record);
  }
}

export function assertRecordMatchesOperationalOp(
  record: ReadableJournalRecord,
  op: JournalRecordInput,
  actor: OperationalActor
): void {
  const legacyActor: JournalActor = { kind: actor.kind, id: actor.id };
  if (record.schema !== "write-journal/v1" || recordFingerprint(record) !== inputFingerprint(op, legacyActor)) {
    collision(record);
  }
}

export function uniquePendingRecords(
  records: ReadonlyArray<ReadableJournalRecord>,
  applied: ReadonlySet<string>
): ReadonlyArray<ReadableJournalRecord> {
  const unique = new Map<string, ReadableJournalRecord>();
  for (const record of records) {
    if (applied.has(record.opId)) continue;
    const previous = unique.get(record.opId);
    if (!previous) {
      unique.set(record.opId, record);
      continue;
    }
    if (recordFingerprint(previous) !== recordFingerprint(record)) collision(record);
  }
  return [...unique.values()];
}

function inputFingerprint(op: JournalRecordInput, attribution: WriteAttribution | JournalActor): string {
  return stablePayloadHash({
    entityId: op.entityId,
    kind: op.kind,
    payloadHash: stablePayloadHash(journalPayload(op)),
    authorityIntegrity: op.authorityIntegrity,
    attribution
  });
}

function recordFingerprint(record: ReadableJournalRecord): string {
  const attribution = record.schema === "write-journal/v2"
    ? {
        actor: record.actor,
        principalSource: record.principalSource,
        executorSource: record.executorSource
      }
    : record.actor;
  return stablePayloadHash({
    entityId: record.entityId,
    kind: record.kind,
    payloadHash: record.payload?.payloadHash,
    authorityIntegrity: record.authorityIntegrity,
    attribution
  });
}

function journalPayload(op: Pick<JournalRecordInput, "opId" | "payload">): Record<string, unknown> {
  if (op.payload === null || typeof op.payload !== "object" || Array.isArray(op.payload)) {
    rejectWrite(`write op payload must be an object: ${op.opId}`);
  }
  return op.payload as Record<string, unknown>;
}

function collision(record: ReadableJournalRecord): never {
  rejectWrite(`op id collision has divergent journal records: ${record.opId}`, record.entityId);
}
