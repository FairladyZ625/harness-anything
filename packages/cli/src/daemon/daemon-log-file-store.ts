import * as fs from "node:fs";
import path from "node:path";
import type {
  DaemonLogEntryV1,
  DaemonLogStorePort,
  DaemonLogStoreReadResult
} from "../../../application/src/index.ts";

export interface DaemonLogFileStoreOptions {
  readonly userRoot: string;
  readonly maxSegmentBytes?: number;
  readonly retentionDays?: number;
  readonly maxSegments?: number;
}

export function makeDaemonLogFileStore(options: DaemonLogFileStoreOptions): DaemonLogStorePort {
  const logRoot = path.join(options.userRoot, "logs", "harness-anything");
  return {
    append: (entry) => appendEntry(logRoot, entry, options),
    read: () => readRecords(logRoot)
  };
}

async function appendEntry(
  logRoot: string,
  entry: DaemonLogEntryV1,
  options: DaemonLogFileStoreOptions
): Promise<void> {
  await fs.promises.mkdir(logRoot, { recursive: true, mode: 0o700 });
  const date = entry.timestamp.slice(0, 10);
  const target = await writableSegment(logRoot, date, options.maxSegmentBytes ?? 10 * 1_024 * 1_024);
  await fs.promises.appendFile(target, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  await enforceRetention(logRoot, entry.timestamp, options.retentionDays ?? 14, options.maxSegments ?? 10);
}

async function readRecords(logRoot: string): Promise<DaemonLogStoreReadResult> {
  const files = await fs.promises.readdir(logRoot).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  });
  const records: unknown[] = [];
  let droppedCount = 0;
  for (const name of files.filter(isDaemonLogSegment).sort(compareDaemonLogSegments)) {
    const body = await fs.promises.readFile(path.join(logRoot, name), "utf8");
    for (const line of body.split("\n").filter((candidate) => candidate.trim().length > 0)) {
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        droppedCount += 1;
      }
    }
  }
  return { records, droppedCount };
}

async function writableSegment(logRoot: string, date: string, maxBytes: number): Promise<string> {
  let index = 0;
  while (true) {
    const name = index === 0 ? `${date}.ndjson` : `${date}.${index}.ndjson`;
    const target = path.join(logRoot, name);
    const size = await fs.promises.stat(target).then((value) => value.size).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return 0;
      throw error;
    });
    if (size < maxBytes) return target;
    index += 1;
  }
}

async function enforceRetention(logRoot: string, now: string, retentionDays: number, maxSegments: number): Promise<void> {
  const names = (await fs.promises.readdir(logRoot)).filter(isDaemonLogSegment).sort(compareDaemonLogSegments).reverse();
  const cutoff = Date.parse(now) - retentionDays * 24 * 60 * 60 * 1_000;
  for (const [index, name] of names.entries()) {
    const date = name.slice(0, 10);
    if (index >= maxSegments || Date.parse(`${date}T00:00:00.000Z`) < cutoff) {
      await fs.promises.unlink(path.join(logRoot, name));
    }
  }
}

function isDaemonLogSegment(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.ndjson$/u.test(name);
}

function compareDaemonLogSegments(left: string, right: string): number {
  const dateOrder = left.slice(0, 10).localeCompare(right.slice(0, 10));
  if (dateOrder !== 0) return dateOrder;
  return segmentIndex(left) - segmentIndex(right);
}

function segmentIndex(name: string): number {
  const match = /^\d{4}-\d{2}-\d{2}(?:\.(\d+))?\.ndjson$/u.exec(name);
  return match?.[1] ? Number(match[1]) : 0;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
