import path from "node:path";
import {
  parseCanonicalEvent,
  serializeCanonicalEvent,
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { DEFAULT_WAL_FLUSH_SETTINGS } from "../domain/settings.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { localWalFileSystem as fileSystem } from "../local/local-layout-file-system.ts";

const WAL_SCHEMA = "harness-wal/v1" as const;
const WAL_SEGMENT = "seg-000000.log";
const WAL_READ_PROGRESS_BATCH_SIZE = DEFAULT_WAL_FLUSH_SETTINGS.events;

export interface WalContentObject {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}

export interface WalEventRecord {
  readonly schema: typeof WAL_SCHEMA;
  readonly revision: number;
  readonly opId: string;
  readonly event: CanonicalEventV1;
  readonly blobs: readonly WalContentObject[];
  readonly eventDigest: `sha256:${string}`;
  readonly previousDigest: `sha256:${string}` | null;
}

export interface WalEventLogProgress {
  readonly applied: number;
  readonly total?: number;
  readonly watermark: number;
}

export interface WalHead {
  readonly schema: "harness-wal-head/v1";
  readonly revision: number;
  readonly lastSegment: string | null;
  readonly lastOffset: number;
  readonly headDigest: `sha256:${string}` | null;
}

export interface WalDurableCutDescriptor {
  readonly schema: "harness-wal-durable-cut/v1";
  readonly throughRevision: number;
  readonly lastOffset: number;
  readonly headDigest: `sha256:${string}`;
}

export interface WalMaterializationSource {
  readonly records: () => readonly WalEventRecord[];
  readonly readContentBlob: (sha256: string) => Uint8Array | null;
}

export interface WalAppendInput {
  readonly event: CanonicalEventV1;
  readonly blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[];
}

export interface WalEventLog {
  readonly rootDir: string;
  readonly head: () => WalHead;
  readonly records: () => readonly WalEventRecord[];
  readonly append: (input: WalAppendInput) => WalEventRecord;
  readonly readEvent: (opId: string) => CanonicalEventV1 | null;
  readonly readContentBlob: (sha256: string) => Uint8Array | null;
  readonly checkpoint: (throughRevision: number) => void;
  readonly checkpointCut: (cut: WalDurableCutDescriptor) => void;
  readonly reseed: (events: readonly CanonicalEventV1[]) => void;
  readonly audit: (gitEvents: readonly CanonicalEventV1[], gitRevision: number) => WalAuditReceipt;
  readonly close: () => void;
}

export interface WalAuditReceipt {
  readonly status: "equivalent" | "diverged";
  readonly walRevision: number;
  readonly gitRevision: number;
  readonly compared: number;
  readonly divergence: string | null;
}

const mutableWalOwners = new Set<string>();

export function openWalEventLog(
  rootDir: string,
  options: {
    readonly mutable?: boolean;
    readonly onInitialReadProgress?: (progress: WalEventLogProgress) => void;
  } = {},
): WalEventLog {
  const normalizedRoot = fileSystem.realpath(path.resolve(rootDir));
  const walRoot = path.join(normalizedRoot, ".harness", "wal");
  const segmentPath = path.join(walRoot, WAL_SEGMENT);
  const objectsRoot = path.join(walRoot, "objects");
  const mutable = options.mutable !== false;
  if (mutable && mutableWalOwners.has(walRoot))
    throw new Error(`mutable WAL owner already exists for ${walRoot}; close it before opening a replacement`);
  if (mutable) mutableWalOwners.add(walRoot);
  let closed = false;
  let cached: WalEventRecord[] | null = null;
  let cachedByOpId: Map<string, WalEventRecord> | null = null;
  let cachedHead: WalHead | null = null;

  const ensureRoot = (): void => {
    assertMutable();
    fileSystem.mkdirp(walRoot);
    fileSystem.mkdirp(objectsRoot);
  };
  const readDiskRecords = (onProgress?: (progress: WalEventLogProgress) => void): WalEventRecord[] => {
    if (!fileSystem.exists(segmentPath)) {
      return [];
    }
    const raw = fileSystem.readText(segmentPath);
    const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
    if (complete !== raw && mutable) fileSystem.replace(segmentPath, complete);
    const lines = complete.split("\n").filter(Boolean);
    const rows: WalEventRecord[] = [];
    for (const [index, line] of lines.entries()) {
      const record = parseRecord(line, index);
      rows.push(record);
      const applied = index + 1;
      if (applied % WAL_READ_PROGRESS_BATCH_SIZE === 0 || applied === lines.length)
        onProgress?.({ applied, watermark: record.revision });
    }
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
      if (current.revision !== previous.revision + 1 || current.previousDigest !== previous.eventDigest)
        throw new Error(`WAL revision or digest chain is not contiguous at revision ${current.revision}`);
      if (index % WAL_READ_PROGRESS_BATCH_SIZE === 0 || index === rows.length - 1)
        onProgress?.({ applied: rows.length + index, watermark: current.revision });
    }
    return rows;
  };
  const readRecords = (): readonly WalEventRecord[] => {
    if (cached !== null) return cached;
    cached = readDiskRecords(options.onInitialReadProgress);
    cachedByOpId = new Map(cached.map((record) => [record.opId, record] as const));
    return cached;
  };
  const readHead = (): WalHead => {
    if (cachedHead !== null) return cachedHead;
    const records = readRecords();
    const last = records.at(-1);
    cachedHead =
      last === undefined
        ? {
            schema: "harness-wal-head/v1",
            revision: 0,
            lastSegment: null,
            lastOffset: 0,
            headDigest: null,
          }
        : {
            schema: "harness-wal-head/v1",
            revision: last.revision,
            lastSegment: WAL_SEGMENT,
            lastOffset: Buffer.byteLength(fileSystem.readText(segmentPath)),
            headDigest: last.eventDigest,
          };
    return cachedHead;
  };
  const writeHead = (head: WalHead): void => {
    assertMutable();
    fileSystem.replace(path.join(walRoot, "head.json"), `${stableStringify(head)}\n`);
    cachedHead = head;
  };
  const append = (input: WalAppendInput): WalEventRecord => {
    ensureRoot();
    const eventBytes = serializeCanonicalEvent(input.event);
    const records = readRecords();
    const existing = cachedByOpId!.get(input.event.opId);
    if (existing !== undefined) {
      if (existing.eventDigest !== `sha256:${sha256Text(eventBytes)}`)
        throw new Error(`WAL opId ${input.event.opId} names different event bytes`);
      return existing;
    }
    const previous = records.at(-1);
    const revision = input.event.workspaceRevision;
    if (previous !== undefined && revision !== previous.revision + 1)
      throw new Error(`WAL revision ${revision} must follow ${previous.revision}`);
    for (const blob of input.blobs) {
      if (sha256Text(blob.body) !== blob.sha256 || Buffer.byteLength(blob.body) !== blob.size)
        throw new Error(`WAL content object ${blob.sha256} does not match its claim`);
      const target = path.join(objectsRoot, blob.sha256);
      if (fileSystem.exists(target)) {
        const existingBody = fileSystem.readText(target);
        if (existingBody !== blob.body) throw new Error(`WAL content object ${blob.sha256} is corrupt`);
      } else fileSystem.replace(target, blob.body);
    }
    const record: WalEventRecord = {
      schema: WAL_SCHEMA,
      revision,
      opId: input.event.opId,
      event: input.event,
      blobs: input.blobs.map(({ sha256, size, mediaType }) => ({
        sha256,
        size,
        mediaType,
      })),
      eventDigest: `sha256:${sha256Text(eventBytes)}`,
      previousDigest: previous?.eventDigest ?? null,
    };
    const body = `${stableStringify(record)}\n`;
    const priorOffset = readHead().lastOffset;
    fileSystem.append(segmentPath, body);
    cached!.push(record);
    cachedByOpId!.set(record.opId, record);
    writeHead({
      schema: "harness-wal-head/v1",
      revision,
      lastSegment: WAL_SEGMENT,
      lastOffset: priorOffset + Buffer.byteLength(body),
      headDigest: record.eventDigest,
    });
    return record;
  };
  const checkpoint = (throughRevision: number): void => {
    assertMutable();
    checkpointDiskRecords(readDiskRecords(), throughRevision);
  };
  const checkpointDiskRecords = (diskRecords: readonly WalEventRecord[], throughRevision: number): void => {
    const remaining = diskRecords.filter((record) => record.revision > throughRevision);
    if (remaining.length === diskRecords.length) {
      cached = [...diskRecords];
      cachedByOpId = new Map(diskRecords.map((record) => [record.opId, record] as const));
      return;
    }
    const body = remaining.map((record) => `${stableStringify(record)}\n`).join("");
    if (body.length === 0) {
      if (fileSystem.exists(segmentPath)) fileSystem.replace(segmentPath, "");
    } else fileSystem.replace(segmentPath, body);
    cached = remaining;
    cachedByOpId = new Map(remaining.map((record) => [record.opId, record] as const));
    const last = remaining.at(-1);
    writeHead(
      last === undefined
        ? {
            schema: "harness-wal-head/v1",
            revision: 0,
            lastSegment: null,
            lastOffset: 0,
            headDigest: null,
          }
        : {
            schema: "harness-wal-head/v1",
            revision: last.revision,
            lastSegment: WAL_SEGMENT,
            lastOffset: Buffer.byteLength(body),
            headDigest: last.eventDigest,
          },
    );
    const referenced = new Set(remaining.flatMap((record) => record.blobs.map((blob) => blob.sha256)));
    if (fileSystem.exists(objectsRoot))
      for (const name of fileSystem.readNames(objectsRoot))
        if (!referenced.has(name)) fileSystem.remove(path.join(objectsRoot, name));
  };
  const checkpointCut = (cut: WalDurableCutDescriptor): void => {
    assertMutable();
    assertDurablePrefix(segmentPath, cut);
    // A checkpoint replaces the whole segment. Reparse the current disk bytes at the
    // destructive boundary so an older instance cache can never erase a suffix appended
    // after the materialized cut was captured.
    const diskRecords = readDiskRecords();
    const record = diskRecords.find((candidate) => candidate.revision === cut.throughRevision);
    if (record?.eventDigest !== cut.headDigest)
      throw new Error(`WAL checkpoint cut ${cut.throughRevision} does not match durable head ${cut.headDigest}`);
    checkpointDiskRecords(diskRecords, cut.throughRevision);
  };
  const reseed = (events: readonly CanonicalEventV1[]): void => {
    ensureRoot();
    const records: WalEventRecord[] = [];
    for (const event of events) {
      const eventBytes = serializePersistedCanonicalEvent(event);
      const previous = records.at(-1);
      records.push({
        schema: WAL_SCHEMA,
        revision: event.workspaceRevision,
        opId: event.opId,
        event,
        blobs: [],
        eventDigest: `sha256:${sha256Text(eventBytes)}`,
        previousDigest: previous?.eventDigest ?? null,
      });
    }
    const body = records.map((record) => `${stableStringify(record)}\n`).join("");
    fileSystem.replace(segmentPath, body);
    cached = records;
    cachedByOpId = new Map(records.map((record) => [record.opId, record] as const));
    const last = records.at(-1);
    writeHead(
      last === undefined
        ? {
            schema: "harness-wal-head/v1",
            revision: 0,
            lastSegment: null,
            lastOffset: 0,
            headDigest: null,
          }
        : {
            schema: "harness-wal-head/v1",
            revision: last.revision,
            lastSegment: WAL_SEGMENT,
            lastOffset: Buffer.byteLength(body),
            headDigest: last.eventDigest,
          },
    );
  };
  return {
    rootDir: walRoot,
    head: readHead,
    records: readRecords,
    append,
    readEvent: (opId) => {
      readRecords();
      return cachedByOpId!.get(opId)?.event ?? null;
    },
    readContentBlob: (sha256) => {
      const target = path.join(objectsRoot, sha256);
      if (fileSystem.exists(target)) return Buffer.from(fileSystem.readText(target));
      return null;
    },
    checkpoint,
    checkpointCut,
    reseed,
    audit: (gitEvents, gitRevision) => auditRecords(readRecords(), gitEvents, gitRevision),
    close: () => {
      if (closed) return;
      closed = true;
      if (mutable) mutableWalOwners.delete(walRoot);
    },
  };

  function assertMutable(): void {
    if (closed) throw new Error(`WAL owner for ${walRoot} is closed`);
    if (!mutable) throw new Error(`WAL reader for ${walRoot} is immutable`);
  }
}

export function captureWalDurableCut(wal: WalEventLog): WalDurableCutDescriptor | null {
  const head = wal.head();
  return head.revision === 0 || head.lastOffset === 0 || head.headDigest === null
    ? null
    : {
        schema: "harness-wal-durable-cut/v1",
        throughRevision: head.revision,
        lastOffset: head.lastOffset,
        headDigest: head.headDigest,
      };
}

export function openWalDurablePrefix(rootDir: string, cut: WalDurableCutDescriptor): WalMaterializationSource {
  const walRoot = path.join(path.resolve(rootDir), ".harness", "wal"),
    segmentPath = path.join(walRoot, WAL_SEGMENT),
    objectsRoot = path.join(walRoot, "objects"),
    records = assertDurablePrefix(segmentPath, cut);
  return {
    records: () => records,
    readContentBlob: (sha256) => {
      const target = path.join(objectsRoot, sha256);
      return fileSystem.exists(target) ? Buffer.from(fileSystem.readText(target)) : null;
    },
  };
}

function assertDurablePrefix(segmentPath: string, cut: WalDurableCutDescriptor): readonly WalEventRecord[] {
  if (
    cut.schema !== "harness-wal-durable-cut/v1" ||
    !Number.isSafeInteger(cut.throughRevision) ||
    cut.throughRevision < 1 ||
    !Number.isSafeInteger(cut.lastOffset) ||
    cut.lastOffset < 1 ||
    !/^sha256:[0-9a-f]{64}$/u.test(cut.headDigest)
  )
    throw new Error("WAL durable cut descriptor is invalid");
  if (!fileSystem.exists(segmentPath)) throw new Error("WAL durable prefix segment is missing");
  const bytes = Buffer.from(fileSystem.readText(segmentPath));
  if (bytes.byteLength < cut.lastOffset)
    throw new Error(`WAL durable prefix is truncated before byte ${cut.lastOffset}`);
  const prefix = bytes.subarray(0, cut.lastOffset).toString("utf8");
  if (!prefix.endsWith("\n") || Buffer.byteLength(prefix) !== cut.lastOffset)
    throw new Error(`WAL durable prefix byte ${cut.lastOffset} is not a record boundary`);
  const records = prefix
    .split("\n")
    .filter(Boolean)
    .map((line, index) => parseRecord(line, index));
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!,
      current = records[index]!;
    if (current.revision !== previous.revision + 1 || current.previousDigest !== previous.eventDigest)
      throw new Error(`WAL revision or digest chain is not contiguous at revision ${current.revision}`);
  }
  const last = records.at(-1);
  if (last?.revision !== cut.throughRevision || last.eventDigest !== cut.headDigest)
    throw new Error(`WAL durable prefix does not end at revision ${cut.throughRevision} and digest ${cut.headDigest}`);
  return records;
}

function parseRecord(line: string, index: number): WalEventRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`WAL record ${index} is not JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`WAL record ${index} has invalid shape`);
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema !== WAL_SCHEMA ||
    typeof candidate.revision !== "number" ||
    !Number.isSafeInteger(candidate.revision) ||
    typeof candidate.opId !== "string" ||
    !Array.isArray(candidate.blobs) ||
    typeof candidate.eventDigest !== "string" ||
    (candidate.previousDigest !== null && typeof candidate.previousDigest !== "string")
  )
    throw new Error(`WAL record ${index} has invalid shape`);
  const event = parseCanonicalEvent(serializePersistedCanonicalEvent(candidate.event as CanonicalEventV1));
  const expected = `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`;
  if (
    candidate.eventDigest !== expected ||
    event.workspaceRevision !== candidate.revision ||
    event.opId !== candidate.opId
  )
    throw new Error(`WAL record ${index} event digest does not match canonical bytes`);
  return candidate as unknown as WalEventRecord;
}

function auditRecords(
  records: readonly WalEventRecord[],
  gitEvents: readonly CanonicalEventV1[],
  gitRevision: number,
): WalAuditReceipt {
  for (const record of records) {
    const gitEvent = gitEvents[record.revision - 1];
    if (
      gitEvent === undefined ||
      record.eventDigest !== `sha256:${sha256Text(serializePersistedCanonicalEvent(gitEvent))}`
    )
      return {
        status: "diverged",
        walRevision: records.at(-1)?.revision ?? 0,
        gitRevision,
        compared: record.revision,
        divergence: `event ${record.revision} digest differs`,
      };
  }
  const lastRevision = records.at(-1)?.revision ?? 0;
  const equivalent = lastRevision === 0 || lastRevision === gitRevision;
  return {
    status: equivalent ? "equivalent" : "diverged",
    walRevision: lastRevision,
    gitRevision,
    compared: records.length,
    divergence: equivalent ? null : `WAL revision ${lastRevision} does not reach Git revision ${gitRevision}`,
  };
}
