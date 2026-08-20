import path from "node:path";
import {
  parseCanonicalEvent,
  serializeCanonicalEvent,
  type CanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { localWalFileSystem as fileSystem } from "../local/local-layout-file-system.ts";

const WAL_SCHEMA = "harness-wal/v1" as const;
const WAL_SEGMENT = "seg-000000.log";

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

export interface WalHead {
  readonly schema: "harness-wal-head/v1";
  readonly revision: number;
  readonly lastSegment: string | null;
  readonly lastOffset: number;
  readonly headDigest: `sha256:${string}` | null;
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
  readonly reseed: (events: readonly CanonicalEventV1[]) => void;
  readonly audit: (
    gitEvents: readonly CanonicalEventV1[],
    gitRevision: number,
  ) => WalAuditReceipt;
}

export interface WalAuditReceipt {
  readonly status: "equivalent" | "diverged";
  readonly walRevision: number;
  readonly gitRevision: number;
  readonly compared: number;
  readonly divergence: string | null;
}

export function openWalEventLog(rootDir: string): WalEventLog {
  const walRoot = path.join(path.resolve(rootDir), ".harness", "wal");
  const segmentPath = path.join(walRoot, WAL_SEGMENT);
  const objectsRoot = path.join(walRoot, "objects");
  let cached: readonly WalEventRecord[] | null = null;
  let cachedHead: WalHead | null = null;

  const ensureRoot = (): void => {
    fileSystem.mkdirp(walRoot);
    fileSystem.mkdirp(objectsRoot);
  };
  const readRecords = (): readonly WalEventRecord[] => {
    if (cached !== null) return cached;
    if (!fileSystem.exists(segmentPath)) {
      cached = [];
      return cached;
    }
    const raw = fileSystem.readText(segmentPath);
    const complete = raw.endsWith("\n")
      ? raw
      : raw.slice(0, raw.lastIndexOf("\n") + 1);
    if (complete !== raw) fileSystem.replace(segmentPath, complete);
    const rows = complete
      .split("\n")
      .filter(Boolean)
      .map((line, index) => parseRecord(line, index));
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
      if (
        current.revision !== previous.revision + 1 ||
        current.previousDigest !== previous.eventDigest
      )
        throw new Error(
          `WAL revision or digest chain is not contiguous at revision ${current.revision}`,
        );
    }
    cached = rows;
    return rows;
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
    fileSystem.replace(
      path.join(walRoot, "head.json"),
      `${stableStringify(head)}\n`,
    );
    cachedHead = head;
  };
  const append = (input: WalAppendInput): WalEventRecord => {
    ensureRoot();
    const eventBytes = serializeCanonicalEvent(input.event);
    const existing = readRecords().find(
      (candidate) => candidate.opId === input.event.opId,
    );
    if (existing !== undefined) {
      if (existing.eventDigest !== `sha256:${sha256Text(eventBytes)}`)
        throw new Error(
          `WAL opId ${input.event.opId} names different event bytes`,
        );
      return existing;
    }
    const previous = readRecords().at(-1);
    const revision = input.event.workspaceRevision;
    if (previous !== undefined && revision !== previous.revision + 1)
      throw new Error(
        `WAL revision ${revision} must follow ${previous.revision}`,
      );
    for (const blob of input.blobs) {
      if (
        sha256Text(blob.body) !== blob.sha256 ||
        Buffer.byteLength(blob.body) !== blob.size
      )
        throw new Error(
          `WAL content object ${blob.sha256} does not match its claim`,
        );
      const target = path.join(objectsRoot, blob.sha256);
      if (fileSystem.exists(target)) {
        const existingBody = fileSystem.readText(target);
        if (existingBody !== blob.body)
          throw new Error(`WAL content object ${blob.sha256} is corrupt`);
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
    const current = fileSystem.exists(segmentPath)
      ? fileSystem.readText(segmentPath)
      : "";
    fileSystem.append(segmentPath, body);
    cached = [...readRecords(), record];
    writeHead({
      schema: "harness-wal-head/v1",
      revision,
      lastSegment: WAL_SEGMENT,
      lastOffset: Buffer.byteLength(current + body),
      headDigest: record.eventDigest,
    });
    return record;
  };
  const checkpoint = (throughRevision: number): void => {
    const remaining = readRecords().filter(
      (record) => record.revision > throughRevision,
    );
    if (remaining.length === readRecords().length) return;
    const body = remaining
      .map((record) => `${stableStringify(record)}\n`)
      .join("");
    if (body.length === 0) {
      if (fileSystem.exists(segmentPath)) fileSystem.replace(segmentPath, "");
    } else fileSystem.replace(segmentPath, body);
    cached = remaining;
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
    const referenced = new Set(
      remaining.flatMap((record) => record.blobs.map((blob) => blob.sha256)),
    );
    if (fileSystem.exists(objectsRoot))
      for (const name of fileSystem.readNames(objectsRoot))
        if (!referenced.has(name)) fileSystem.remove(path.join(objectsRoot, name));
  };
  const reseed = (events: readonly CanonicalEventV1[]): void => {
    ensureRoot();
    const records: WalEventRecord[] = [];
    for (const event of events) {
      const eventBytes = serializeCanonicalEvent(event);
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
    readEvent: (opId) =>
      readRecords().find((record) => record.opId === opId)?.event ?? null,
    readContentBlob: (sha256) => {
      const target = path.join(objectsRoot, sha256);
      if (fileSystem.exists(target)) return Buffer.from(fileSystem.readText(target));
      return null;
    },
    checkpoint,
    reseed,
    audit: (gitEvents, gitRevision) =>
      auditRecords(readRecords(), gitEvents, gitRevision),
  };
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
    (candidate.previousDigest !== null &&
      typeof candidate.previousDigest !== "string")
  )
    throw new Error(`WAL record ${index} has invalid shape`);
  const event = parseCanonicalEvent(
    serializeCanonicalEvent(candidate.event as CanonicalEventV1),
  );
  const expected = `sha256:${sha256Text(serializeCanonicalEvent(event))}`;
  if (
    candidate.eventDigest !== expected ||
    event.workspaceRevision !== candidate.revision ||
    event.opId !== candidate.opId
  )
    throw new Error(
      `WAL record ${index} event digest does not match canonical bytes`,
    );
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
      record.eventDigest !==
        `sha256:${sha256Text(serializeCanonicalEvent(gitEvent))}`
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
    divergence: equivalent
      ? null
      : `WAL revision ${lastRevision} does not reach Git revision ${gitRevision}`,
  };
}
