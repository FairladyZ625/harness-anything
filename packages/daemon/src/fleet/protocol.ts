import { TextDecoder } from "node:util";
import type { ReplicationCommit, ReplicationPosition } from "@harness-anything/kernel";
import type { BaseBackupMetadata } from "./basebackup.ts";

export const REPLICATION_FRAME_BYTES = 96 * 1024;
export const REPLICATION_CHUNK_BYTES = 64 * 1024;

export type ReplicationFrame =
  | { readonly type: "replica.start"; readonly repoId: string; readonly position: ReplicationPosition | null }
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
export const isReplicationPosition = (value: unknown): value is ReplicationPosition =>
  shape(value, { history: text, sequence: uint, revision: uint });
export const isBaseBackupMetadata = (value: unknown): value is BaseBackupMetadata =>
  shape(value, {
    schema: (v) => v === "fleet-basebackup/v2",
    repoId: text,
    readerProfile: (v) => v === null || shape(v, { personId: text, nodeId: text }),
    position: isReplicationPosition,
    ledgerGeneration: uint,
    projectionSchema: uint,
  });

export function parseReplicationFrame(line: string): ReplicationFrame {
  if (Buffer.byteLength(line) > REPLICATION_FRAME_BYTES) throw new Error("replication frame exceeds capacity");
  const value: unknown = JSON.parse(line);
  if (!object(value) || typeof value.type !== "string") throw new Error("invalid replication frame");
  const types: Record<string, Record<string, Check>> = {
    "replica.start": { repoId: text, position: (v) => v === null || isReplicationPosition(v) },
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
  if (!fields || !shape(value, { type: (v) => v === value.type, ...fields }))
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
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    const frames: ReplicationFrame[] = [];
    for (;;) {
      const newline = this.#pending.indexOf("\n");
      if (newline < 0) break;
      frames.push(parseReplicationFrame(this.#pending.slice(0, newline)));
      this.#pending = this.#pending.slice(newline + 1);
    }
    if (Buffer.byteLength(this.#pending) > REPLICATION_FRAME_BYTES)
      throw new Error("replication pending frame exceeds capacity");
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
  const string = (v: unknown) => typeof v === "string";
  const nullableUint = (v: unknown) => v === null || uint(v);
  const nullableString = (v: unknown) => v === null || string(v);
  const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
  if (
    !shape(value, {
      position: isReplicationPosition,
      events: (v) =>
        Array.isArray(v) &&
        v.every((row) =>
          shape(row, {
            revision: uint,
            opId: text,
            eventJson: string,
            occurredAt: text,
            recordedAt: text,
            digest,
          }),
        ),
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
    throw new Error("invalid replication commit envelope");
  const commit = value as ReplicationCommit;
  const first = commit.events[0],
    last = commit.events.at(-1);
  if (
    commit.events.some((row, index) => row.revision !== first!.revision + index) ||
    (last !== undefined && last.revision !== commit.position.revision) ||
    (commit.outcome !== null &&
      (commit.outcome.firstRevision !== (first?.revision ?? null) ||
        commit.outcome.lastRevision !== (last?.revision ?? null) ||
        JSON.stringify(commit.outcome.memberOpIds) !== JSON.stringify(commit.events.map((row) => row.opId)))) ||
    (commit.outcome === null && commit.events.length > 0)
  )
    throw new Error("replication commit interval differs");
  return commit;
}
