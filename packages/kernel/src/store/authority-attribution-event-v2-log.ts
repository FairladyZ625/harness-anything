import path from "node:path";
import {
  authorityAttributionEventV2BytesEqual,
  authorityAttributionEventV2KeyDigest,
  authorityAttributionEventV2ProtocolDamage,
  decodeAuthorityAttributionEventV2Bytes,
  encodeAuthorityAttributionEventV2Bytes
} from "../integrity/authority-attribution-event-v2-log.ts";
import { sha256Bytes, stablePayloadHash } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import { decodeAndVerifyAttributionEventV2, type AttributionEventV2 } from "../schemas/attribution-event-union.ts";
import {
  appendImmutableBytesDurably,
  durableFileExists,
  readFileBytes
} from "./write-journal-durable.ts";
import {
  recoverAuthorityAttributionEventV2FromOperationRecord,
  type RecoverableAuthorityOperationRecordV2,
  type RecoverAuthorityAttributionEventV2Input
} from "./authority-attribution-event-v2-recovery.ts";

export const authorityAttributionEventV2IntegrityReportSchema =
  "authority-attribution-event-v2-integrity-report/v1" as const;

export interface AuthorityAttributionEventV2AppendResult {
  readonly event: AttributionEventV2;
  readonly bytes: Uint8Array;
  readonly bytesSha256: string;
  readonly replayed: boolean;
}

export interface AuthorityAttributionEventV2IntegrityReport {
  readonly schema: typeof authorityAttributionEventV2IntegrityReportSchema;
  readonly eventCount: number;
  readonly logDigest: string;
}

export interface AuthorityAttributionEventV2Log {
  readonly ensure: (event: AttributionEventV2) => AuthorityAttributionEventV2AppendResult;
  readonly read: (workspaceId: string, opId: string) => AttributionEventV2 | undefined;
  readonly readBytes: (workspaceId: string, opId: string) => Uint8Array | undefined;
  readonly readAll: () => ReadonlyArray<AttributionEventV2>;
  readonly scanIntegrity: () => AuthorityAttributionEventV2IntegrityReport;
  readonly recoverFromOperationRecord: <RecordType extends RecoverableAuthorityOperationRecordV2>(
    input: Omit<RecoverAuthorityAttributionEventV2Input<RecordType>, "log">
  ) => Promise<AuthorityAttributionEventV2AppendResult>;
}

export function makeLocalAuthorityAttributionEventV2Log(
  rootInput: HarnessLayoutInput
): AuthorityAttributionEventV2Log {
  return {
    ensure: (event) => ensureAuthorityAttributionEventV2(rootInput, event),
    read: (workspaceId, opId) => readAuthorityAttributionEventV2(rootInput, workspaceId, opId),
    readBytes: (workspaceId, opId) => readAuthorityAttributionEventV2Bytes(rootInput, workspaceId, opId),
    readAll: () => readAllAuthorityAttributionEventsV2(rootInput),
    scanIntegrity: () => scanAuthorityAttributionEventV2Integrity(rootInput),
    recoverFromOperationRecord: (input) => recoverAuthorityAttributionEventV2FromOperationRecord({
      ...input,
      log: makeLocalAuthorityAttributionEventV2Log(rootInput)
    })
  };
}

export function authorityAttributionEventV2FilePath(
  rootInput: HarnessLayoutInput,
  workspaceId: string,
  opId: string
): string {
  const keyDigest = authorityAttributionEventV2KeyDigest(workspaceId, opId);
  return path.join(resolveHarnessLayout(rootInput).authorityAttributionEventsV2Root, `${keyDigest}.jsonl`);
}

function ensureAuthorityAttributionEventV2(
  rootInput: HarnessLayoutInput,
  candidate: AttributionEventV2
): AuthorityAttributionEventV2AppendResult {
  const event = decodeAndVerifyAttributionEventV2(candidate);
  const bytes = encodeAuthorityAttributionEventV2Bytes(event);
  const eventPath = authorityAttributionEventV2FilePath(rootInput, event.workspaceId, event.opId);
  const created = appendImmutableBytesDurably(eventPath, bytes);
  const durableBytes = readFileBytes(eventPath);
  if (!authorityAttributionEventV2BytesEqual(durableBytes, bytes)) {
    throw authorityAttributionEventV2ProtocolDamage(`different bytes already exist for (${event.workspaceId}, ${event.opId})`);
  }
  const durableEvent = decodeAuthorityAttributionEventV2Bytes(durableBytes);
  assertEventKey(rootInput, durableEvent, event.workspaceId, event.opId, eventPath);
  return {
    event: durableEvent,
    bytes: durableBytes,
    bytesSha256: sha256Bytes(durableBytes),
    replayed: !created
  };
}

function readAuthorityAttributionEventV2(
  rootInput: HarnessLayoutInput,
  workspaceId: string,
  opId: string
): AttributionEventV2 | undefined {
  const eventPath = authorityAttributionEventV2FilePath(rootInput, workspaceId, opId);
  if (!durableFileExists(eventPath)) return undefined;
  const event = decodeAuthorityAttributionEventV2Bytes(readFileBytes(eventPath));
  assertEventKey(rootInput, event, workspaceId, opId, eventPath);
  return event;
}

function readAuthorityAttributionEventV2Bytes(
  rootInput: HarnessLayoutInput,
  workspaceId: string,
  opId: string
): Uint8Array | undefined {
  const eventPath = authorityAttributionEventV2FilePath(rootInput, workspaceId, opId);
  if (!durableFileExists(eventPath)) return undefined;
  const bytes = readFileBytes(eventPath);
  const event = decodeAuthorityAttributionEventV2Bytes(bytes);
  assertEventKey(rootInput, event, workspaceId, opId, eventPath);
  return bytes;
}

function readAllAuthorityAttributionEventsV2(
  rootInput: HarnessLayoutInput
): ReadonlyArray<AttributionEventV2> {
  const root = resolveHarnessLayout(rootInput).authorityAttributionEventsV2Root;
  if (!durableFileExists(root)) return [];
  const events = localLayoutFileSystem.readDirents(root)
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".jsonl"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const eventPath = path.join(root, entry.name);
      const event = decodeAuthorityAttributionEventV2Bytes(readFileBytes(eventPath));
      assertEventKey(rootInput, event, event.workspaceId, event.opId, eventPath);
      return event;
    });
  const keys = new Set<string>();
  for (const event of events) {
    const key = `${event.workspaceId}\0${event.opId}`;
    if (keys.has(key)) throw authorityAttributionEventV2ProtocolDamage(`duplicate durable V2 key (${event.workspaceId}, ${event.opId})`);
    keys.add(key);
  }
  return events.sort((left, right) =>
    left.revision - right.revision
      || left.workspaceId.localeCompare(right.workspaceId)
      || left.opId.localeCompare(right.opId));
}

function scanAuthorityAttributionEventV2Integrity(
  rootInput: HarnessLayoutInput
): AuthorityAttributionEventV2IntegrityReport {
  const log = makeLocalAuthorityAttributionEventV2Log(rootInput);
  const events = log.readAll();
  return {
    schema: authorityAttributionEventV2IntegrityReportSchema,
    eventCount: events.length,
    logDigest: stablePayloadHash({
      schema: "authority-attribution-event-v2-log-digest/v1",
      events: events.map((event) => ({
        workspaceId: event.workspaceId,
        opId: event.opId,
        bytesSha256: sha256Bytes(encodeAuthorityAttributionEventV2Bytes(event))
      }))
    })
  };
}

function assertEventKey(
  rootInput: HarnessLayoutInput,
  event: AttributionEventV2,
  workspaceId: string,
  opId: string,
  actualPath: string
): void {
  if (event.workspaceId !== workspaceId || event.opId !== opId) {
    throw authorityAttributionEventV2ProtocolDamage(`stored V2 event key does not match (${workspaceId}, ${opId})`);
  }
  const expectedPath = authorityAttributionEventV2FilePath(
    rootInput,
    workspaceId,
    opId
  );
  if (path.resolve(actualPath) !== path.resolve(expectedPath)) {
    throw authorityAttributionEventV2ProtocolDamage(`stored V2 event path does not match (${workspaceId}, ${opId})`);
  }
}
