import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Schema } from "effect";
import { sha256Text } from "../integrity/stable-hash.ts";
import { ReadableJournalRecordSchema } from "../schemas/write-journal.ts";
import type { ApplyMarkerRecord, DeleteAuditRecord, JournalActor, JournalRecord, JournalRecordV1, LockTakeoverRecord, NormalizedJournalRecordV1, PayloadRef, ReadableJournalRecord, WriteWatermark } from "./write-journal-types.ts";

export function readDurableState(journalPath: string, watermarkPath: string, rootDir: string): {
  readonly records: ReadonlyArray<ReadableJournalRecord>;
  readonly watermark: WriteWatermark | null;
  readonly applied: ReadonlySet<string>;
  readonly fileApplied: ReadonlySet<string>;
} {
  const watermark = readWatermark(watermarkPath);
  const records = readJournal(journalPath, rootDir);
  return {
    records,
    watermark,
    applied: new Set(watermark?.lastCommittedOpIds ?? []),
    fileApplied: readApplyMarkers(journalPath)
  };
}

// Op ids whose file mutation already happened (apply-marker/v1 lines). Replay must
// not re-run these writes even though the global watermark does not cover them yet.
export function readApplyMarkers(journalPath: string): ReadonlySet<string> {
  if (!existsSync(journalPath)) return new Set();
  const body = readFileSync(journalPath, "utf8").trim();
  if (body.length === 0) return new Set();

  const markers = new Set<string>();
  for (const line of body.split("\n")) {
    const parsed = JSON.parse(line) as Partial<ApplyMarkerRecord>;
    if (parsed.schema === "apply-marker/v1" && typeof parsed.opId === "string") {
      markers.add(parsed.opId);
    }
  }
  return markers;
}

export function readJournal(journalPath: string, rootDir: string): ReadonlyArray<ReadableJournalRecord> {
  if (!existsSync(journalPath)) return [];
  const body = readFileSync(journalPath, "utf8").trim();
  if (body.length === 0) return [];

  const records: ReadableJournalRecord[] = [];
  for (const line of body.split("\n")) {
    const parsed: unknown = JSON.parse(line);
    const schema = journalLineSchema(parsed);
    if (schema === "lock-takeover/v1" || schema === "delete-audit/v1" || schema === "apply-marker/v1") continue;
    if (schema !== "write-journal/v1" && schema !== "write-journal/v2") {
      throw new Error("malformed journal record: unsupported schema");
    }
    let decoded: JournalRecordV1 | ReadableJournalRecord;
    try {
      decoded = Schema.decodeUnknownSync(ReadableJournalRecordSchema)(parsed);
    } catch (cause) {
      throw new Error("malformed journal record: schema decode failed", { cause });
    }
    if (!decoded.payloadRef) throw new Error("malformed journal record: payloadRef is required");
    readPayloadRef(rootDir, decoded);
    records.push(decoded.schema === "write-journal/v1" ? normalizeLegacyRecord(decoded) : decoded);
  }
  return records;
}

export function findRecord(records: ReadonlyArray<ReadableJournalRecord>, opId: string): ReadableJournalRecord {
  const record = records.find((candidate) => candidate.opId === opId);
  if (!record) throw new Error(`journal record missing for op ${opId}`);
  return record;
}

export function readWatermark(watermarkPath: string): WriteWatermark | null {
  if (!existsSync(watermarkPath)) return null;
  const parsed = JSON.parse(readFileSync(watermarkPath, "utf8")) as Partial<WriteWatermark>;
  if (parsed.schema !== "write-watermark/v1" || !Array.isArray(parsed.lastCommittedOpIds)) {
    throw new Error("malformed watermark");
  }
  return parsed as WriteWatermark;
}

export function writePayloadRef(rootDir: string, journalPath: string, opId: string, payload: Record<string, unknown>): PayloadRef {
  const relativeJournalDir = path.relative(rootDir, path.dirname(journalPath)).split(path.sep).join("/");
  const relativePath = `${relativeJournalDir}/payloads/${encodeURIComponent(opId)}.json`;
  const absolutePath = path.join(rootDir, relativePath);
  const body = JSON.stringify(payload);
  writeFileDurably(absolutePath, body);
  return {
    path: relativePath,
    sha256: sha256Text(body)
  };
}

export function readPayloadRef(rootDir: string, record: Pick<ReadableJournalRecord | JournalRecord, "opId" | "payloadRef">): Record<string, unknown> {
  if (!record.payloadRef) throw new Error(`payloadRef missing for op ${record.opId}`);
  const absolutePath = path.join(rootDir, record.payloadRef.path);
  const body = readFileSync(absolutePath, "utf8");
  const actualSha = sha256Text(body);
  if (actualSha !== record.payloadRef.sha256) {
    throw new Error(`payloadRef sha mismatch for op ${record.opId}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

export function appendJsonLineDurably(filePath: string, value: JournalRecord | JournalRecordV1 | LockTakeoverRecord | DeleteAuditRecord | ApplyMarkerRecord | Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function appendImmutableJsonLineDurably(filePath: string, value: object): boolean {
  return appendImmutableBytesDurably(filePath, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

export function appendImmutableBytesDurably(filePath: string, bytes: Uint8Array): boolean {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) return false;
  // Never expose an incomplete immutable object at its canonical name.  A
  // hard-link install is an atomic, no-replace publish on the local volume;
  // unlike rename(2), it cannot overwrite an already-complete shard.
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(tempPath, "wx");
  immutableWriteKillpoint("post-create");
  try {
    const buffer = Buffer.from(bytes);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const requested = process.env.HARNESS_TEST_IMMUTABLE_WRITE_KILLPOINT === "partial-write"
        ? Math.max(1, Math.floor((buffer.byteLength - offset) / 2))
        : buffer.byteLength - offset;
      const written = writeSync(fd, buffer, offset, requested, offset);
      if (written === 0) throw new Error(`durable immutable write made no progress: ${filePath}`);
      offset += written;
      immutableWriteKillpoint("partial-write");
    }
    fsyncSync(fd);
    immutableWriteKillpoint("post-file-fsync");
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(tempPath, filePath);
    } catch (error) {
      if (existsSync(filePath)) return false;
      throw error;
    }
    immutableWriteKillpoint("pre-directory-fsync");
    fsyncDirectory(path.dirname(filePath));
    immutableWriteKillpoint("post-directory-fsync");
    return true;
  } finally {
    // A crash may leave only this private temp object.  It is never treated as
    // a replayable shard and a later attempt uses a fresh name.
    if (existsSync(tempPath)) removeFileDurably(tempPath);
  }
}

function immutableWriteKillpoint(point: string): void {
  if (process.env.HARNESS_TEST_IMMUTABLE_WRITE_KILLPOINT === point) {
    process.kill(process.pid, "SIGKILL");
  }
}

function journalLineSchema(value: unknown): unknown {
  return typeof value === "object" && value !== null && "schema" in value
    ? value.schema
    : undefined;
}

function normalizeLegacyRecord(record: JournalRecordV1): NormalizedJournalRecordV1 {
  const actor = record.actor satisfies JournalActor;
  return {
    ...record,
    legacyAttribution: {
      status: "unresolved",
      source: "legacy",
      principal: null,
      executor: actor.kind === "agent" ? { kind: "agent", id: actor.id } : null,
      actor
    }
  };
}

export function writeWatermarkDurably(filePath: string, watermark: WriteWatermark): void {
  writeFileDurably(filePath, JSON.stringify(watermark));
}

export function durableFileExists(filePath: string): boolean {
  return existsSync(filePath);
}

export function readFileBytes(filePath: string): Uint8Array {
  return readFileSync(filePath);
}

export function removeFileDurably(filePath: string): void {
  rmSync(filePath, { force: true });
  fsyncDirectory(path.dirname(filePath));
}

export function writeFileDurably(filePath: string, body: string | Uint8Array): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tempPath, "w");
  try {
    if (typeof body === "string") {
      writeSync(fd, body, null, "utf8");
    } else {
      const buffer = Buffer.from(body);
      writeSync(fd, buffer, 0, buffer.byteLength, 0);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
  fsyncDirectory(path.dirname(filePath));
}

export function fsyncDirectory(dirPath: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dirPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
