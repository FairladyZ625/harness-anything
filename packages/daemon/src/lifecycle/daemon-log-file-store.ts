import * as fs from "node:fs";
import path from "node:path";
import type {
  DaemonLogEntryV1,
  DaemonLogStorePort,
  DaemonLogStoreReadResult
} from "@harness-anything/application";

export interface DaemonLogFileStoreOptions {
  readonly userRoot: string;
  readonly maxSegmentBytes?: number;
  readonly retentionDays?: number;
  readonly maxSegments?: number;
}

export function makeDaemonLogFileStore(options: DaemonLogFileStoreOptions): DaemonLogStorePort {
  const logRoot = path.join(options.userRoot, "logs", "harness-anything");
  const state: DaemonLogAppendState = { logRoot };
  let appendTail = Promise.resolve();
  return {
    append: (entry) => {
      const operation = appendTail.then(() => appendEntry(state, entry, options));
      appendTail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    read: async () => {
      await appendTail;
      return readRecords(logRoot);
    }
  };
}

interface DaemonLogAppendState {
  readonly logRoot: string;
  rootReady?: Promise<void>;
  segment?: {
    readonly date: string;
    readonly index: number;
    readonly target: string;
    bytes: number;
  };
  maintenanceDue?: boolean;
}

async function appendEntry(
  state: DaemonLogAppendState,
  entry: DaemonLogEntryV1,
  options: DaemonLogFileStoreOptions
): Promise<void> {
  await ensureLogRoot(state);
  const date = entry.timestamp.slice(0, 10);
  const maxSegmentBytes = options.maxSegmentBytes ?? 10 * 1_024 * 1_024;
  const rotated = await ensureWritableSegment(state, date, maxSegmentBytes);
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await fs.promises.appendFile(state.segment!.target, line, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      state.rootReady = undefined;
      state.segment = undefined;
    }
    throw error;
  }
  state.segment!.bytes += Buffer.byteLength(line, "utf8");
  state.maintenanceDue ||= rotated;
  if (state.maintenanceDue) {
    await enforceRetention(
      state.logRoot,
      entry.timestamp,
      options.retentionDays ?? 14,
      options.maxSegments ?? 10
    );
    state.maintenanceDue = false;
  }
}

async function ensureLogRoot(state: DaemonLogAppendState): Promise<void> {
  state.rootReady ??= fs.promises.mkdir(state.logRoot, { recursive: true, mode: 0o700 })
    .then(() => undefined)
    .catch((error: unknown) => {
      state.rootReady = undefined;
      throw error;
    });
  await state.rootReady;
}

async function ensureWritableSegment(
  state: DaemonLogAppendState,
  date: string,
  maxBytes: number
): Promise<boolean> {
  const current = state.segment;
  if (current?.date === date && current.bytes < maxBytes) return false;
  const nextIndex = current?.date === date ? current.index + 1 : 0;
  state.segment = await writableSegment(state.logRoot, date, maxBytes, nextIndex);
  return true;
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

async function writableSegment(
  logRoot: string,
  date: string,
  maxBytes: number,
  startIndex: number
): Promise<NonNullable<DaemonLogAppendState["segment"]>> {
  let index = startIndex;
  while (true) {
    const name = index === 0 ? `${date}.ndjson` : `${date}.${index}.ndjson`;
    const target = path.join(logRoot, name);
    const size = await fs.promises.stat(target).then((value) => value.size).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return 0;
      throw error;
    });
    if (size < maxBytes) return { date, index, target, bytes: size };
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
