import {
  canonicalCborBytesEqual,
  decodeAndVerifyAttributionEventV2,
  encodeCanonicalCbor,
  type AttributionEventV2,
  type CanonicalCborValue,
  type PhysicalChangeV2
} from "../../../kernel/src/index.ts";
import { materializeCommittedAttributionEventV2 } from "./committed-attribution-event-v2.ts";
import type { AuthorityCommittedEventPublisherV2 } from "./types.ts";

export interface AuthorityAttributionEventLogRecordV2 {
  readonly workspaceId: string;
  readonly opId: string;
  readonly canonicalBytes: Uint8Array;
  readonly event: AttributionEventV2;
}

/** Port implemented by X's parallel append-only authority-attribution-event/v2 primitive. */
export interface AuthorityAttributionEventLogPrimitiveV2 {
  readonly appendExact: (record: AuthorityAttributionEventLogRecordV2) => Promise<void>;
  readonly readExact: (
    workspaceId: string,
    opId: string
  ) => Promise<AuthorityAttributionEventLogRecordV2 | undefined>;
}

export interface AuthorityCommittedPhysicalObservationV2 {
  readonly physicalChanges: ReadonlyArray<PhysicalChangeV2>;
  readonly recordedAt: string;
}

export interface AuthorityCommittedPhysicalObservationPortV2 {
  readonly observe: (input: {
    readonly workspaceId: string;
    readonly opId: string;
    readonly commitSha: string;
  }) => Promise<AuthorityCommittedPhysicalObservationV2>;
}

export function createDurableAuthorityCommittedEventPublisherV2(options: {
  readonly eventLog: AuthorityAttributionEventLogPrimitiveV2;
  readonly observation: AuthorityCommittedPhysicalObservationPortV2;
}): AuthorityCommittedEventPublisherV2 {
  return {
    publish: async (input) => {
      const observed = await options.observation.observe({
        workspaceId: input.receipt.workspaceId,
        opId: input.receipt.opId,
        commitSha: input.receipt.commitSha
      });
      const event = materializeCommittedAttributionEventV2({
        receipt: input.receipt,
        actorAxesBinding: input.actorAxesBinding,
        physicalChanges: observed.physicalChanges,
        occurredAt: input.occurredAt,
        recordedAt: observed.recordedAt
      });
      const canonicalBytes = canonicalAuthorityAttributionEventStorageBytesV2(event);
      await options.eventLog.appendExact({
        workspaceId: event.workspaceId,
        opId: event.opId,
        canonicalBytes,
        event
      });
      const stored = await options.eventLog.readExact(event.workspaceId, event.opId);
      if (!stored) throw new Error("AUTHORITY_EVENT_V2_DURABLE_READ_MISSING");
      if (stored.workspaceId !== event.workspaceId || stored.opId !== event.opId
        || !canonicalCborBytesEqual(stored.canonicalBytes, canonicalBytes)) {
        throw new Error("AUTHORITY_EVENT_V2_DURABLE_REPLAY_MISMATCH");
      }
      const storedEvent = decodeAndVerifyAttributionEventV2(stored.event);
      if (!canonicalCborBytesEqual(
        canonicalAuthorityAttributionEventStorageBytesV2(storedEvent),
        stored.canonicalBytes
      )) throw new Error("AUTHORITY_EVENT_V2_DURABLE_BYTES_MISMATCH");
      return storedEvent;
    }
  };
}

/** Exact whole-event bytes used by the V2 event-log port's idempotence check. */
export function canonicalAuthorityAttributionEventStorageBytesV2(event: AttributionEventV2): Uint8Array {
  return encodeCanonicalCbor(toAuthorityEventCanonicalCbor(decodeAndVerifyAttributionEventV2(event)));
}

function toAuthorityEventCanonicalCbor(value: unknown): CanonicalCborValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("AUTHORITY_EVENT_V2_CANONICAL_NUMBER_INVALID");
    return value;
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(toAuthorityEventCanonicalCbor);
  if (typeof value !== "object") throw new Error("AUTHORITY_EVENT_V2_CANONICAL_VALUE_INVALID");
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, toAuthorityEventCanonicalCbor(entry)]));
}
