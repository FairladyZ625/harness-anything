import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { TextDecoder } from "node:util";
import type {
  BaseBackupMetadata,
  CenterMovedDetails,
  ReplicationCommit,
  ReplicationPosition,
  SqliteEventRow,
} from "@harness-anything/storage";

export class ReplicationError extends Error {
  readonly code: string;
  readonly centerMoved?: CenterMovedDetails;
  constructor(message: string, code = "replica_protocol_error", centerMoved?: CenterMovedDetails) {
    super(message);
    this.code = code;
    if (centerMoved) this.centerMoved = centerMoved;
  }
}

export const REPLICATION_FRAME_BYTES = daemonProtocolFleetPolicy.defaultValue.fleet.frameBytes;
export const REPLICATION_CHUNK_BYTES = daemonProtocolFleetPolicy.defaultValue.fleet.chunkBytes;
export const REPLICATION_BINARY_CHUNK_BYTES = REPLICATION_CHUNK_BYTES * 4;
export const REPLICATION_OBJECT_MANIFEST_BATCH = 500;
export const REPLICATION_OBJECT_PACK_MAX_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_RESUME_CAPABILITY = "snapshot-resume/v1";
export const SNAPSHOT_BINARY_WIRE_CAPABILITY = "snapshot-binary-wire/v1";
export const SNAPSHOT_OBJECT_PACK_CAPABILITY = "snapshot-object-pack/v1";
export const CENTER_MOVED_DETAILS_CAPABILITY = "center-moved-details/v1";
export const BINARY_DATA_FRAME_TAG = 0x00;
export const BINARY_DATA_HEADER_BYTES = 13;

export type ReplicationFrame =
  | {
      readonly type: "replica.start";
      readonly repoId: string;
      readonly position: ReplicationPosition | null;
      readonly edgeBuildCommit?: string | null;
      readonly taskEventShapeVersion?: number;
      readonly capabilities?: readonly string[];
      readonly resumeSnapshot?: { readonly snapshotId: string; readonly offset: number };
    }
  | {
      readonly type: "replica.accept";
      readonly centerBuildCommit: string | null;
      readonly taskEventShapeVersion: number;
      readonly capabilities?: readonly string[];
    }
  | {
      readonly type: "replica.reject";
      readonly code: string;
      readonly message: string;
      readonly centerBuildCommit: string | null;
      readonly taskEventShapeVersion: number;
      readonly centerMoved?: {
        readonly newExternalUrl: string;
        readonly newLoginUrl: string;
        readonly newEpoch: number;
        readonly spkiSha256: string;
      };
    }
  | {
      readonly type: "replica.failure";
      readonly code: string;
      readonly message: string;
      readonly centerMoved?: {
        readonly newExternalUrl: string;
        readonly newLoginUrl: string;
        readonly newEpoch: number;
        readonly spkiSha256: string;
      };
    }
  | {
      readonly type: "replica.backup";
      readonly metadata: BaseBackupMetadata;
      readonly size: number;
      readonly sha256: string;
      readonly snapshotId?: string;
      readonly resumeOffset?: number;
      readonly objectsMode?: "inline" | "pack";
      readonly objectCount?: number;
    }
  | { readonly type: "replica.data"; readonly offset: number; readonly data: string }
  | { readonly type: "replica.data.bin"; readonly offset: number; readonly data: Uint8Array }
  | { readonly type: "replica.backup.end" }
  | {
      readonly type: "replica.objects.manifest";
      readonly entries: readonly { readonly sha256: string; readonly size: number }[];
      readonly done: boolean;
    }
  | { readonly type: "replica.objects.want"; readonly sha256s: readonly string[] }
  | { readonly type: "replica.objects.pack"; readonly totalBytes: number; readonly count: number }
  | { readonly type: "replica.objects.pack.end" }
  | { readonly type: "replica.commit"; readonly size: number }
  | { readonly type: "replica.object"; readonly sha256: string; readonly size: number }
  | { readonly type: "replica.object.end" }
  | { readonly type: "replica.commit.end" }
  | { readonly type: "replica.ack"; readonly durable: ReplicationPosition; readonly applied: ReplicationPosition }
  | { readonly type: "replica.progress"; readonly head: ReplicationPosition }
  | { readonly type: "replica.resync"; readonly reason: string };

/** Both directions use the existing authenticated TLS session; no second network listener. */
export interface ReplicationPeer {
  readonly send: (frame: ReplicationFrame) => Promise<void>;
  readonly receive: (signal?: AbortSignal) => Promise<ReplicationFrame>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uint = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
type Check = (value: unknown) => boolean;
const shape = (value: unknown, fields: Record<string, Check>): boolean =>
  object(value) &&
  Object.keys(value).length === Object.keys(fields).length &&
  Object.entries(fields).every(([key, check]) => check(value[key]));
const isCapabilities = (value: unknown): boolean => Array.isArray(value) && value.length <= 32 && value.every(text);
const isResumeSnapshot = (value: unknown): boolean => shape(value, { snapshotId: text, offset: uint });
const optionalShape = (value: unknown, required: Record<string, Check>, optional: Record<string, Check>): boolean => {
  if (!object(value)) return false;
  for (const [key, check] of Object.entries(required)) {
    if (!Object.hasOwn(value, key) || !check(value[key])) return false;
  }
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(required, key)) continue;
    if (!Object.hasOwn(optional, key) || !optional[key]!(value[key])) return false;
  }
  return true;
};
const isReplicaStart = (value: unknown): boolean =>
  object(value) &&
  Object.hasOwn(value, "edgeBuildCommit") === Object.hasOwn(value, "taskEventShapeVersion") &&
  optionalShape(
    value,
    {
      type: (v: unknown) => v === "replica.start",
      repoId: text,
      position: (v: unknown) => v === null || isReplicationPosition(v),
    },
    {
      edgeBuildCommit: (v: unknown) => v === null || text(v),
      taskEventShapeVersion: uint,
      capabilities: isCapabilities,
      resumeSnapshot: isResumeSnapshot,
    },
  );
const isReplicaAccept = (value: unknown): boolean =>
  optionalShape(
    value,
    {
      type: (v: unknown) => v === "replica.accept",
      centerBuildCommit: (v: unknown) => v === null || text(v),
      taskEventShapeVersion: uint,
    },
    {
      capabilities: isCapabilities,
    },
  );
const isCenterMoved = (value: unknown): boolean =>
  shape(value, { newExternalUrl: text, newLoginUrl: text, newEpoch: uint, spkiSha256: text });
const isReplicaReject = (value: unknown): boolean =>
  optionalShape(
    value,
    {
      type: (v: unknown) => v === "replica.reject",
      code: text,
      message: text,
      centerBuildCommit: (v: unknown) => v === null || text(v),
      taskEventShapeVersion: uint,
    },
    { centerMoved: isCenterMoved },
  );
const isReplicaFailure = (value: unknown): boolean =>
  optionalShape(
    value,
    {
      type: (v: unknown) => v === "replica.failure",
      code: text,
      message: text,
    },
    { centerMoved: isCenterMoved },
  );
const isReplicaBackup = (value: unknown): boolean =>
  optionalShape(
    value,
    {
      type: (v: unknown) => v === "replica.backup",
      metadata: isBaseBackupMetadata,
      size: uint,
      sha256: hash,
    },
    {
      snapshotId: text,
      resumeOffset: uint,
      objectsMode: (v: unknown) => v === "inline" || v === "pack",
      objectCount: uint,
    },
  ) &&
  Object.hasOwn(value as object, "snapshotId") === Object.hasOwn(value as object, "resumeOffset") &&
  ((value as { readonly resumeOffset?: number }).resumeOffset === undefined ||
    (value as { readonly resumeOffset: number; readonly size: number }).resumeOffset <=
      (value as { readonly size: number }).size);
export const isReplicationPosition = (value: unknown): value is ReplicationPosition =>
  shape(value, { history: text, sequence: uint, revision: uint });
export const isBaseBackupMetadata = (value: unknown): value is BaseBackupMetadata =>
  shape(value, {
    schema: (v) => v === "fleet-basebackup/v3",
    repoId: text,
    readerProfile: (v) => v === null || shape(v, { personId: text, nodeId: text }),
    position: isReplicationPosition,
    ledgerGeneration: uint,
    projectionSchema: uint,
  });

export function parseReplicationFrame(line: string): ReplicationFrame {
  const bytes = Buffer.byteLength(line);
  let value: unknown;
  try {
    if (bytes > REPLICATION_FRAME_BYTES) throw new Error("replication frame exceeds capacity");
    value = JSON.parse(line);
    return parseReplicationFrameValue(value);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error)),
      frame = object(value) ? value : {},
      label = (v: unknown) => (typeof v === "string" ? v.slice(0, 128) : null);
    // Keep discriminators and size, never document contents, credentials or bulk data.
    const summary = {
      bytes,
      type: label(frame.type),
      schema: label(frame.schema),
      metadataSchema: object(frame.metadata) ? label(frame.metadata.schema) : null,
    };
    failure.message = `${failure instanceof SyntaxError ? "invalid replication JSON" : failure.message}; frame=${JSON.stringify(summary)}`;
    throw failure;
  }
}

function parseReplicationFrameValue(value: unknown): ReplicationFrame {
  if (!object(value) || typeof value.type !== "string") throw new Error("invalid replication frame");
  if (value.type === "replica.backup" && object(value.metadata) && value.metadata.schema === "fleet-basebackup/v2")
    throw Object.assign(
      new Error("center_upgrade_required: the center sent fleet-basebackup/v2; this edge requires v3."),
      { code: "center_upgrade_required" },
    );
  const types: Record<string, Record<string, Check>> = {
    "replica.data": {
      offset: uint,
      data: (v) =>
        typeof v === "string" &&
        v.length > 0 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(v) &&
        Buffer.byteLength(v, "base64") <= REPLICATION_CHUNK_BYTES,
    },
    "replica.backup.end": {},
    "replica.objects.manifest": {
      entries: (v) =>
        Array.isArray(v) && v.length <= 1024 && v.every((entry) => shape(entry, { sha256: hash, size: uint })),
      done: (v) => typeof v === "boolean",
    },
    "replica.objects.want": {
      sha256s: (v) => Array.isArray(v) && v.length <= 1024 && v.every(hash),
    },
    "replica.objects.pack": { totalBytes: uint, count: uint },
    "replica.objects.pack.end": {},
    "replica.commit": { size: uint },
    "replica.object": { sha256: hash, size: uint },
    "replica.object.end": {},
    "replica.commit.end": {},
    "replica.ack": { durable: isReplicationPosition, applied: isReplicationPosition },
    "replica.progress": { head: isReplicationPosition },
    "replica.resync": { reason: text },
  };
  const fields = Object.hasOwn(types, value.type) ? types[value.type] : undefined;
  const valid =
    value.type === "replica.start"
      ? isReplicaStart(value)
      : value.type === "replica.accept"
        ? isReplicaAccept(value)
        : value.type === "replica.reject"
          ? isReplicaReject(value)
          : value.type === "replica.failure"
            ? isReplicaFailure(value)
            : value.type === "replica.backup"
              ? isReplicaBackup(value)
              : Boolean(fields && shape(value, { type: (v) => v === value.type, ...fields }));
  if (!valid) throw new Error("invalid replication frame");
  return value as unknown as ReplicationFrame;
}

export function serializeReplicationFrame(frame: ReplicationFrame): string {
  if (frame.type === "replica.data.bin") {
    throw new Error("replica.data.bin requires binary wire serialization");
  }
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line) > REPLICATION_FRAME_BYTES) throw new Error("replication frame exceeds capacity");
  return `${line}\n`;
}

export function serializeReplicationWireFrame(frame: ReplicationFrame): string | Buffer {
  if (frame.type === "replica.data.bin") {
    if (!Number.isSafeInteger(frame.offset) || frame.offset < 0)
      throw new Error("invalid binary replication frame offset");
    if (frame.data.byteLength === 0 || frame.data.byteLength > REPLICATION_BINARY_CHUNK_BYTES)
      throw new Error("binary replication frame exceeds capacity");
    const wire = Buffer.allocUnsafe(BINARY_DATA_HEADER_BYTES + frame.data.byteLength);
    wire[0] = BINARY_DATA_FRAME_TAG;
    wire.writeBigUInt64BE(BigInt(frame.offset), 1);
    wire.writeUInt32BE(frame.data.byteLength, 9);
    Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).copy(wire, BINARY_DATA_HEADER_BYTES);
    return wire;
  }
  return serializeReplicationFrame(frame);
}

export class ReplicationDecoder {
  #pending: Buffer = Buffer.alloc(0);
  push(chunk: Uint8Array): readonly ReplicationFrame[] {
    if (chunk.byteLength > 0) {
      const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      this.#pending = this.#pending.length === 0 ? Buffer.from(incoming) : Buffer.concat([this.#pending, incoming]);
    }
    const frames: ReplicationFrame[] = [];
    while (this.#pending.length > 0) {
      if (this.#pending[0] === BINARY_DATA_FRAME_TAG) {
        if (this.#pending.length < BINARY_DATA_HEADER_BYTES) break;
        const offsetBig = this.#pending.readBigUInt64BE(1);
        const length = this.#pending.readUInt32BE(9);
        if (offsetBig > BigInt(Number.MAX_SAFE_INTEGER) || length === 0 || length > REPLICATION_BINARY_CHUNK_BYTES) {
          throw new Error(
            `invalid binary replication frame; frame=${JSON.stringify({ offset: offsetBig.toString(), length })}`,
          );
        }
        const total = BINARY_DATA_HEADER_BYTES + length;
        if (this.#pending.length < total) break;
        const data = Buffer.from(this.#pending.subarray(BINARY_DATA_HEADER_BYTES, total));
        this.#pending = this.#pending.subarray(total);
        frames.push({ type: "replica.data.bin", offset: Number(offsetBig), data });
        continue;
      }
      const newline = this.#pending.indexOf(0x0a);
      if (newline < 0) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(this.#pending, { stream: true });
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          failure.message += `; frame=${JSON.stringify({ pendingBytes: this.#pending.length, chunkBytes: chunk.byteLength })}`;
          throw failure;
        }
        break;
      }
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(this.#pending.subarray(0, newline));
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failure.message += `; frame=${JSON.stringify({ pendingBytes: newline, chunkBytes: chunk.byteLength })}`;
        throw failure;
      }
      this.#pending = this.#pending.subarray(newline + 1);
      frames.push(parseReplicationFrame(line));
    }
    if (
      this.#pending.length > 0 &&
      this.#pending[0] !== BINARY_DATA_FRAME_TAG &&
      this.#pending.length > REPLICATION_FRAME_BYTES
    )
      throw new Error(`replication pending frame exceeds capacity; frameBytes=${this.#pending.length}`);
    return frames;
  }
  finish(): void {
    if (this.#pending.length) throw new Error("replication stream ended mid-frame");
  }
}

/** Decode the transaction envelope only; canonical event content was accepted by the center. */
export function parseReplicationCommit(bytes: Uint8Array): ReplicationCommit {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validateReplicationCommit(value);
  return value as ReplicationCommit;
}

/** Shared envelope/interval boundary for buffered legacy callers and staged event iterators. */
export function validateReplicationCommit(
  value: unknown,
): asserts value is ReplicationCommit<Iterable<SqliteEventRow>> {
  const string = (v: unknown) => typeof v === "string";
  const nullableUint = (v: unknown) => v === null || uint(v);
  const nullableString = (v: unknown) => v === null || string(v);
  const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
  if (
    !shape(value, {
      position: isReplicationPosition,
      events: (v) => v !== null && typeof v === "object" && Symbol.iterator in v,
      outcome: (v) =>
        v === null ||
        shape(v, {
          opId: text,
          status: (s) => s === "accepted_durable" || s === "rejected",
          firstRevision: nullableUint,
          lastRevision: nullableUint,
          intentDigest: digest,
          summary: string,
          rejectionCode: nullableString,
          recordedAt: text,
          memberOpIds: (ids) => Array.isArray(ids) && ids.every(text),
        }),
      writer: (v) => v === null || shape(v, { repoId: text, holder: text, epoch: uint }),
    })
  )
    throw new ReplicationError("invalid replication commit envelope", "replica_protocol_error");
  const commit = value as ReplicationCommit<Iterable<SqliteEventRow>>;
  let count = 0,
    first: SqliteEventRow | undefined,
    last: SqliteEventRow | undefined;
  for (const row of commit.events) {
    if (!shape(row, { revision: uint, opId: text, eventJson: string, occurredAt: text, recordedAt: text, digest }))
      throw new ReplicationError("invalid replication commit envelope", "replica_protocol_error");
    first ??= row;
    if (row.revision !== first.revision + count || commit.outcome?.memberOpIds[count] !== row.opId)
      throw new ReplicationError("replication commit interval differs", "replica_protocol_error");
    count++;
    last = row;
  }
  if (
    (last !== undefined && last.revision !== commit.position.revision) ||
    (commit.outcome !== null &&
      (commit.outcome.firstRevision !== (first?.revision ?? null) ||
        commit.outcome.lastRevision !== (last?.revision ?? null) ||
        commit.outcome.memberOpIds.length !== count)) ||
    (commit.outcome === null && count > 0)
  )
    throw new ReplicationError("replication commit interval differs", "replica_protocol_error");
}
