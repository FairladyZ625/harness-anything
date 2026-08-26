import { readdirSync, statSync, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";
import type {
  ObserveTailCursor,
  ObserveTailDirection,
  ObserveTailKind,
  ObserveTailResult,
} from "./protocol/daemon-protocol-gui-types.ts";

const pageSize = 64;
const readChunkBytes = 64 * 1024;

export type JsonlTailKind = Exclude<ObserveTailKind, "events">;
export interface JsonlTailFile {
  readonly path: string;
  readonly fileId: string;
  readonly order: readonly [string, number];
}
export type JsonlRecordSelector = (
  record: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>> | null;
export type JsonlTailPage =
  | Pick<
      Extract<ObserveTailResult, { readonly status: "ready" | "pending" }>,
      "status" | "items" | "historyCursor" | "liveCursor" | "sourceCursor" | "done"
    >
  | Pick<
      Extract<ObserveTailResult, { readonly status: "gap" }>,
      "status" | "items" | "historyCursor" | "liveCursor" | "sourceCursor" | "done" | "gap"
    >;

export async function readJsonlTail(
  kind: JsonlTailKind,
  direction: ObserveTailDirection,
  cursor: ObserveTailCursor | undefined,
  snapshot: () => readonly JsonlTailFile[],
  select: JsonlRecordSelector = (record) => record,
): Promise<JsonlTailPage> {
  return direction === "history"
    ? readJsonlHistory(kind, cursor, snapshot, select)
    : readJsonlFollow(kind, cursor!, snapshot, select);
}

export function snapshotJsonlFiles(
  dir: string,
  orderOf: (name: string) => readonly [string, number] | null,
): readonly JsonlTailFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  return names
    .flatMap((name): JsonlTailFile[] => {
      const order = orderOf(name);
      if (!order) return [];
      const file = jsonlTailFile(path.join(dir, name), order);
      return file === null ? [] : [file];
    })
    .sort((left, right) => left.order[0].localeCompare(right.order[0]) || right.order[1] - left.order[1]);
}

export function singleJsonlFile(target: string): readonly JsonlTailFile[] {
  const file = jsonlTailFile(target, ["dispatch", 0]);
  return file === null ? [] : [file];
}

async function readJsonlHistory(
  kind: JsonlTailKind,
  cursor: ObserveTailCursor | undefined,
  snapshot: () => readonly JsonlTailFile[],
  select: JsonlRecordSelector,
): Promise<JsonlTailPage> {
  const requested = cursor as Extract<ObserveTailCursor, { readonly kind: typeof kind }> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const files = snapshot();
    if (files.length === 0) {
      if (requested) return gap(kind, "cursor-file-not-retained", requested.fileId);
      return emptyHistoryPage();
    }
    const start = requested ? files.findIndex((file) => file.fileId === requested.fileId) : files.length - 1;
    if (start < 0) {
      if (attempt === 0) continue;
      return gap(kind, "cursor-file-not-retained", requested!.fileId);
    }
    try {
      const items: Readonly<Record<string, unknown>>[] = [];
      let historyCursor: Extract<ObserveTailCursor, { readonly kind: typeof kind }> | null = null;
      const sourceCursor = await retainedEndCursor(kind, files);
      for (let index = start; index >= 0; index -= 1) {
        const file = files[index]!,
          initialOffset = index === start && requested ? requested.offset : await completeEndOffset(file),
          scanned = await scanFileBackward(file, initialOffset, pageSize - items.length, select);
        if (scanned.outOfRange) return gap(kind, "cursor-offset-out-of-range", requested?.fileId ?? file.fileId);
        items.unshift(...scanned.items);
        if (scanned.items.length > 0) historyCursor = { kind, fileId: file.fileId, offset: scanned.offset };
        if (items.length === pageSize)
          return {
            status: "ready",
            items,
            historyCursor,
            liveCursor: requested ?? sourceCursor,
            sourceCursor,
            done: index === 0 && scanned.offset === 0,
          };
      }
      return {
        status: "ready",
        items,
        historyCursor,
        liveCursor: requested ?? sourceCursor,
        sourceCursor,
        done: true,
      };
    } catch (error) {
      if (error instanceof TailSnapshotChanged && attempt === 0) continue;
      throw error;
    }
  }
  throw tailError("log_snapshot_unstable", "JSONL files kept changing while the tail snapshot was read; retry.");
}

async function readJsonlFollow(
  kind: JsonlTailKind,
  cursor: ObserveTailCursor,
  snapshot: () => readonly JsonlTailFile[],
  select: JsonlRecordSelector,
): Promise<JsonlTailPage> {
  const requested = cursor as Extract<ObserveTailCursor, { readonly kind: typeof kind }>;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const files = snapshot();
    if (files.length === 0) return gap(kind, "cursor-file-not-retained", requested.fileId);
    const start = files.findIndex((file) => file.fileId === requested.fileId);
    if (start < 0) {
      if (attempt === 0) continue;
      return gap(kind, "cursor-file-not-retained", requested.fileId);
    }
    try {
      const items: Readonly<Record<string, unknown>>[] = [];
      let liveCursor: Extract<ObserveTailCursor, { readonly kind: typeof kind }> = requested;
      for (let index = start; index < files.length; index += 1) {
        const file = files[index]!,
          initialOffset = index === start ? requested.offset : 0,
          scanned = await scanFileForward(file, initialOffset, pageSize - items.length, select);
        if (scanned.outOfRange) return gap(kind, "cursor-offset-out-of-range", requested.fileId);
        items.push(...scanned.items);
        liveCursor = { kind, fileId: file.fileId, offset: scanned.offset };
        if (items.length === pageSize) {
          const sourceCursor = await retainedEndCursor(kind, files);
          return {
            status: "ready",
            items,
            historyCursor: null,
            liveCursor,
            sourceCursor,
            done: sameCursor(liveCursor, sourceCursor),
          };
        }
        if (scanned.partial && index < files.length - 1)
          throw tailError("log_record_invalid", `Retained JSONL ${path.basename(file.path)} has a partial line.`);
      }
      const sourceCursor = await retainedEndCursor(kind, files);
      return {
        status: "ready",
        items,
        historyCursor: null,
        liveCursor,
        sourceCursor,
        done: sameCursor(liveCursor, sourceCursor),
      };
    } catch (error) {
      if (error instanceof TailSnapshotChanged && attempt === 0) continue;
      throw error;
    }
  }
  throw tailError("log_snapshot_unstable", "JSONL files kept changing while the tail snapshot was read; retry.");
}

async function retainedEndCursor(
  kind: JsonlTailKind,
  files: readonly JsonlTailFile[],
): Promise<Extract<ObserveTailCursor, { readonly kind: typeof kind }>> {
  const last = files.at(-1)!;
  return { kind, fileId: last.fileId, offset: await completeEndOffset(last) };
}

/** Last complete JSONL boundary; an in-flight partial append is deliberately not exposed. */
async function completeEndOffset(file: JsonlTailFile): Promise<number> {
  const opened = await openStableFile(file);
  try {
    const buffer = Buffer.allocUnsafe(Math.min(readChunkBytes, Math.max(opened.size, 1)));
    let end = opened.size;
    while (end > 0) {
      const start = Math.max(0, end - buffer.length),
        length = end - start;
      await readExactAt(opened.handle, buffer, length, start);
      const finalNewline = buffer.subarray(0, length).lastIndexOf(0x0a);
      if (finalNewline >= 0) return start + finalNewline + 1;
      end = start;
    }
    return 0;
  } finally {
    await opened.handle.close();
  }
}

async function scanFileBackward(
  file: JsonlTailFile,
  initialOffset: number,
  limit: number,
  select: JsonlRecordSelector,
): Promise<{
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly offset: number;
  readonly outOfRange: boolean;
}> {
  const opened = await openStableFile(file);
  try {
    if (initialOffset > opened.size || !(await isLineBoundary(opened.handle, initialOffset)))
      return { items: [], offset: initialOffset, outOfRange: true };
    if (initialOffset === 0 || limit === 0) return { items: [], offset: initialOffset, outOfRange: false };
    const reversed: Readonly<Record<string, unknown>>[] = [];
    let position = initialOffset,
      carry = Buffer.alloc(0),
      offset = initialOffset;
    while (position > 0 && reversed.length < limit) {
      const chunkStart = Math.max(0, position - readChunkBytes),
        length = position - chunkStart,
        chunk = Buffer.allocUnsafe(length);
      await readExactAt(opened.handle, chunk, length, chunkStart);
      const window = carry.length === 0 ? chunk : Buffer.concat([chunk, carry]);
      let boundary = window.length;
      while (boundary > 0 && reversed.length < limit) {
        if (window[boundary - 1] !== 0x0a)
          throw tailError("log_record_invalid", `Retained JSONL ${path.basename(file.path)} has a partial line.`);
        const previousNewline = window.lastIndexOf(0x0a, boundary - 2);
        if (previousNewline < 0 && chunkStart > 0) break;
        const lineStart = previousNewline + 1,
          line = window.subarray(lineStart, boundary - 1),
          selected = line.length === 0 ? null : select(parseJsonlRecord(file.path, line));
        offset = chunkStart + lineStart;
        boundary = lineStart;
        if (selected !== null) reversed.push(selected);
      }
      carry = boundary === 0 ? Buffer.alloc(0) : window.subarray(0, boundary);
      position = chunkStart;
    }
    return { items: reversed.reverse(), offset: reversed.length === limit ? offset : 0, outOfRange: false };
  } finally {
    await opened.handle.close();
  }
}

async function isLineBoundary(handle: FileHandle, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const byte = Buffer.allocUnsafe(1),
    result = await handle.read(byte, 0, 1, offset - 1);
  return result.bytesRead === 1 && byte[0] === 0x0a;
}

async function scanFileForward(
  file: JsonlTailFile,
  initialOffset: number,
  limit: number,
  select: JsonlRecordSelector,
): Promise<{
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly offset: number;
  readonly partial: boolean;
  readonly outOfRange: boolean;
}> {
  const opened = await openStableFile(file);
  try {
    if (initialOffset > opened.size) return { items: [], offset: initialOffset, partial: false, outOfRange: true };
    const buffer = Buffer.allocUnsafe(Math.min(readChunkBytes, Math.max(opened.size - initialOffset, 1))),
      items: Readonly<Record<string, unknown>>[] = [];
    let position = initialOffset,
      completeOffset = initialOffset,
      pending = Buffer.alloc(0);
    while (position < opened.size) {
      const length = Math.min(buffer.length, opened.size - position);
      await readExactAt(opened.handle, buffer, length, position);
      let lineStart = 0;
      for (;;) {
        const newline = buffer.indexOf(0x0a, lineStart);
        if (newline < 0 || newline >= length) break;
        const segment = buffer.subarray(lineStart, newline),
          line = pending.length === 0 ? segment : Buffer.concat([pending, segment]);
        pending = Buffer.alloc(0);
        completeOffset = position + newline + 1;
        lineStart = newline + 1;
        const selected = line.length === 0 ? null : select(parseJsonlRecord(file.path, line));
        if (selected !== null) items.push(selected);
        if (items.length === limit) return { items, offset: completeOffset, partial: false, outOfRange: false };
      }
      if (lineStart < length) pending = Buffer.concat([pending, buffer.subarray(lineStart, length)]);
      position += length;
    }
    return { items, offset: completeOffset, partial: pending.length > 0, outOfRange: false };
  } finally {
    await opened.handle.close();
  }
}

async function openStableFile(file: JsonlTailFile): Promise<{ readonly handle: FileHandle; readonly size: number }> {
  let handle: FileHandle;
  try {
    handle = await open(file.path, "r");
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") throw new TailSnapshotChanged();
    throw error;
  }
  try {
    const current = await handle.stat({ bigint: true });
    if (fileIdentity(current) !== file.fileId) throw new TailSnapshotChanged();
    const size = Number(current.size);
    if (!Number.isSafeInteger(size)) throw tailError("log_file_too_large", "Retained JSONL is not seekable.");
    return { handle, size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readExactAt(handle: FileHandle, buffer: Buffer, length: number, position: number): Promise<void> {
  let received = 0;
  while (received < length) {
    const result = await handle.read(buffer, received, length - received, position + received);
    if (result.bytesRead === 0) throw new TailSnapshotChanged();
    received += result.bytesRead;
  }
}

function parseJsonlRecord(filePath: string, bytes: Buffer): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw tailError(
      "log_record_invalid",
      `Retained JSONL ${path.basename(filePath)} contains invalid UTF-8 JSON: ${detail}.`,
    );
  }
  if (!isJsonObject(value))
    throw tailError("log_record_invalid", `Retained JSONL ${path.basename(filePath)} has a non-object record.`);
  return value;
}

function jsonlTailFile(target: string, order: readonly [string, number]): JsonlTailFile | null {
  try {
    const stat = statSync(target, { bigint: true });
    return stat.isFile() ? { path: target, fileId: fileIdentity(stat), order } : null;
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") {
      consumeKnownError(error);
      return null;
    }
    throw error;
  }
}

function emptyHistoryPage(): JsonlTailPage {
  return {
    status: "ready",
    items: [],
    historyCursor: null,
    liveCursor: null,
    sourceCursor: null,
    done: true,
  };
}

function gap(
  kind: JsonlTailKind,
  reason: "cursor-file-not-retained" | "cursor-offset-out-of-range",
  requestedFileId: string,
): Extract<JsonlTailPage, { readonly status: "gap" }> {
  return {
    status: "gap",
    items: [],
    historyCursor: null,
    liveCursor: null,
    sourceCursor: null,
    done: false,
    gap: { reason, requestedFileId },
  };
}

export function sameCursor(left: ObserveTailCursor | null, right: ObserveTailCursor | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fileIdentity(stat: BigIntStats): string {
  return `${stat.dev.toString(36)}:${stat.ino.toString(36)}:${stat.birthtimeNs.toString(36)}`;
}

function fsErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function tailError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

class TailSnapshotChanged extends Error {}
