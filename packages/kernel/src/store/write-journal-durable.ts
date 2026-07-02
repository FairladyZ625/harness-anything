import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { ApplyMarkerRecord, DeleteAuditRecord, JournalRecord, LockTakeoverRecord, PayloadRef, WriteWatermark } from "./write-journal-types.ts";

export function readDurableState(journalPath: string, watermarkPath: string, rootDir: string): {
  readonly records: ReadonlyArray<JournalRecord>;
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
// not re-run these non-idempotent writes even though the watermark does not cover
// them yet.
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

export function readJournal(journalPath: string, rootDir: string): ReadonlyArray<JournalRecord> {
  if (!existsSync(journalPath)) return [];
  const body = readFileSync(journalPath, "utf8").trim();
  if (body.length === 0) return [];

  const records: JournalRecord[] = [];
  for (const line of body.split("\n")) {
    const parsed = JSON.parse(line) as Partial<JournalRecord | LockTakeoverRecord | DeleteAuditRecord | ApplyMarkerRecord>;
    if (parsed.schema === "lock-takeover/v1") continue;
    if (parsed.schema === "delete-audit/v1") continue;
    if (parsed.schema === "apply-marker/v1") continue;
    if (parsed.schema !== "write-journal/v1") {
      throw new Error("malformed journal record: unsupported schema");
    }
    if (
      typeof parsed.opId !== "string" ||
      typeof parsed.taskId !== "string" ||
      typeof parsed.kind !== "string" ||
      !parsed.actor ||
      typeof parsed.at !== "string" ||
      !parsed.payloadRef
    ) {
      throw new Error("malformed journal record: missing required fields");
    }
    readPayloadRef(rootDir, parsed as JournalRecord);
    records.push(parsed as JournalRecord);
  }
  return records;
}

export function findRecord(records: ReadonlyArray<JournalRecord>, opId: string): JournalRecord {
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

export function readPayloadRef(rootDir: string, record: JournalRecord): Record<string, unknown> {
  if (!record.payloadRef) throw new Error(`payloadRef missing for op ${record.opId}`);
  const absolutePath = path.join(rootDir, record.payloadRef.path);
  const body = readFileSync(absolutePath, "utf8");
  const actualSha = sha256Text(body);
  if (actualSha !== record.payloadRef.sha256) {
    throw new Error(`payloadRef sha mismatch for op ${record.opId}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

export function appendJsonLineDurably(filePath: string, value: JournalRecord | LockTakeoverRecord | DeleteAuditRecord | ApplyMarkerRecord): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeWatermarkDurably(filePath: string, watermark: WriteWatermark): void {
  writeFileDurably(filePath, JSON.stringify(watermark));
}

export function writeFileDurably(filePath: string, body: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tempPath, "w");
  try {
    writeSync(fd, body, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
  fsyncDirectory(path.dirname(filePath));
}

export function fsyncDirectory(dirPath: string): void {
  const fd = openSync(dirPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
