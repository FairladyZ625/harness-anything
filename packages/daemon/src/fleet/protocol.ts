import { TextDecoder } from "node:util";
import type { ReplicationCommit, ReplicationPosition, SqliteEventRow } from "@harness-anything/storage";
import type { BaseBackupMetadata } from "@harness-anything/storage";

export class ReplicationError extends Error {
  readonly code: string;
  constructor(message: string, code = "replica_protocol_error") {
    super(message);
    this.code = code;
  }
}

export const REPLICATION_FRAME_BYTES = 96 * 1024;
export const REPLICATION_CHUNK_BYTES = 64 * 1024;

export type ReplicationFrame =
  | {
      readonly type: "replica.start";
      readonly repoId: string;
      readonly position: ReplicationPosition | null;
      readonly edgeBuildCommit?: string | null;
      readonly taskEventShapeVersion?: number;
    }
  | {
      readonly type: "replica.accept";
      readonly centerBuildCommit: string | null;
      readonly taskEventShapeVersion: number;
    }
  | {
      readonly type: "replica.reject";
      readonly code: string;
      readonly message: string;
      readonly centerBuildCommit: string | null;
      readonly taskEventShapeVersion: number;
    }
  | { readonly type: "replica.failure"; readonly code: string; readonly message: string }
  | {
      readonly type: "replica.backup";
      readonly metadata: BaseBackupMetadata;
      readonly size: number;
      readonly sha256: string;
    }
  | { readonly type: "replica.data"; readonly offset: number; readonly data: string }
  | { readonly type: "replica.backup.end" }
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
const isReplicaStart = (value: unknown): boolean => {
  const common = {
    type: (v: unknown) => v === "replica.start",
    repoId: text,
    position: (v: unknown) => v === null || isReplicationPosition(v),
  };
  return (
    shape(value, common) ||
    shape(value, {
      ...common,
      edgeBuildCommit: (v: unknown) => v === null || text(v),
      taskEventShapeVersion: uint,
    })
  );
};
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
    "replica.accept": {
      centerBuildCommit: (v) => v === null || text(v),
      taskEventShapeVersion: uint,
    },
    "replica.reject": {
      code: text,
      message: text,
      centerBuildCommit: (v) => v === null || text(v),
      taskEventShapeVersion: uint,
    },
    "replica.failure": { code: text, message: text },
    "replica.backup": { metadata: isBaseBackupMetadata, size: uint, sha256: hash },
    "replica.data": {
      offset: uint,
      data: (v) =>
        typeof v === "string" &&
        v.length > 0 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(v) &&
        Buffer.byteLength(v, "base64") <= REPLICATION_CHUNK_BYTES,
    },
    "replica.backup.end": {},
    "replica.commit": { size: uint },
    "replica.object": { sha256: hash, size: uint },
    "replica.object.end": {},
    "replica.commit.end": {},
    "replica.ack": { durable: isReplicationPosition, applied: isReplicationPosition },
    "replica.progress": { head: isReplicationPosition },
    "replica.resync": { reason: text },
  };
  const fields = Object.hasOwn(types, value.type) ? types[value.type] : undefined;
  if (
    !(value.type === "replica.start"
      ? isReplicaStart(value)
      : fields && shape(value, { type: (v) => v === value.type, ...fields }))
  )
    throw new Error("invalid replication frame");
  return value as unknown as ReplicationFrame;
}

export function serializeReplicationFrame(frame: ReplicationFrame): string {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line) > REPLICATION_FRAME_BYTES) throw new Error("replication frame exceeds capacity");
  return `${line}\n`;
}

export class ReplicationDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #pending = "";
  push(chunk: Uint8Array): readonly ReplicationFrame[] {
    try {
      this.#pending += this.#decoder.decode(chunk, { stream: true });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.message += `; frame=${JSON.stringify({ pendingBytes: Buffer.byteLength(this.#pending), chunkBytes: chunk.byteLength })}`;
      throw failure;
    }
    const frames: ReplicationFrame[] = [];
    for (;;) {
      const newline = this.#pending.indexOf("\n");
      if (newline < 0) break;
      frames.push(parseReplicationFrame(this.#pending.slice(0, newline)));
      this.#pending = this.#pending.slice(newline + 1);
    }
    if (Buffer.byteLength(this.#pending) > REPLICATION_FRAME_BYTES)
      throw new Error(`replication pending frame exceeds capacity; frameBytes=${Buffer.byteLength(this.#pending)}`);
    return frames;
  }
  finish(): void {
    this.#pending += this.#decoder.decode();
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
