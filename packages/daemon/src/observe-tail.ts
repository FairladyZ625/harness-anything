import { readdirSync, statSync, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { DaemonRepoMode, TaskProjection } from "../../kernel/src/index.ts";
import { daemonConnLogFileStem } from "./conn-log.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { daemonRequestLogPath } from "./request-log.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";
import { DAEMON_OBSERVE_TAIL_SCHEMA } from "./protocol/daemon-protocol-schema-ids.ts";
import {
  validateObserveTailPayload,
  type ObserveTailCursor,
  type ObserveTailPayload,
  type ObserveTailResult,
} from "./protocol/daemon-protocol-gui-types.ts";

export { DAEMON_OBSERVE_TAIL_SCHEMA };
export type { ObserveTailCursor, ObserveTailPayload, ObserveTailResult };

const pageSize = 64;
const readChunkBytes = 64 * 1024;

export async function readObserveTail(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly mode: DaemonRepoMode;
  readonly projection: TaskProjection;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly payload: unknown;
}): Promise<ObserveTailResult> {
  const payload = parseObserveTailPayload(input.payload),
    base = {
      schema: DAEMON_OBSERVE_TAIL_SCHEMA.id,
      ok: true as const,
      repoId: input.repoId,
      mode: input.mode,
      kind: payload.kind,
    };
  if (payload.kind === "events") {
    if (input.mode === "remote-edge")
      return {
        ...base,
        status: "unavailable",
        items: [],
        cursor: null,
        sourceCursor: null,
        done: false,
        unavailable: {
          reason: "edge-mirror-has-no-events",
          centerRevision: edgeCenterRevision(input.rootDir, input.repoId),
        },
      };
    const after = payload.cursor?.revision ?? 0,
      page = input.projection.readCanonicalEvents(after, pageSize + 1);
    if (after > page.sourceRevision)
      throw observeError(
        "invalid_cursor",
        `Canonical event cursor ${after} is ahead of source revision ${page.sourceRevision}.`,
      );
    const selected = page.events.slice(0, pageSize),
      revision = selected.at(-1)?.workspaceRevision ?? after,
      cursor = { kind: "events" as const, revision };
    return {
      ...base,
      status: page.status,
      items: selected,
      cursor,
      sourceCursor: { kind: "events", revision: page.sourceRevision },
      done: page.status === "ready" && page.events.length <= pageSize && revision === page.sourceRevision,
    };
  }
  if (payload.kind === "repo-log" && input.mode === "remote-center")
    return {
      ...base,
      status: "unavailable",
      items: [],
      cursor: null,
      sourceCursor: null,
      done: false,
      unavailable: { reason: "center-request-log-not-wired", centerRevision: null },
    };
  const logPage = await readJsonlTail(
    payload.kind,
    payload.cursor,
    payload.kind === "repo-log"
      ? () => repoLogFiles(input.rootDir)
      : () => daemonLogFiles(input.userRoot, input.daemonId),
  );
  return { ...base, ...logPage };
}

function parseObserveTailPayload(value: unknown): ObserveTailPayload {
  const errors = validateObserveTailPayload(value);
  if (errors.length) throw observeError("invalid_request", errors.join("; "));
  return value as unknown as ObserveTailPayload;
}

interface TailFile {
  readonly path: string;
  readonly fileId: string;
  readonly order: readonly [string, number];
}

async function readJsonlTail(
  kind: "repo-log" | "daemon-log",
  cursor: ObserveTailCursor | undefined,
  snapshot: () => readonly TailFile[],
): Promise<LogTailPage> {
  const requested = cursor as Extract<ObserveTailCursor, { readonly kind: typeof kind }> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const files = snapshot();
    if (files.length === 0) {
      if (requested) return gap(kind, "cursor-file-not-retained", requested.fileId);
      return { status: "ready", items: [], cursor: null, sourceCursor: null, done: true };
    }
    const start = requested ? files.findIndex((file) => file.fileId === requested.fileId) : 0;
    if (start < 0) {
      if (attempt === 0) continue;
      return gap(kind, "cursor-file-not-retained", requested!.fileId);
    }
    try {
      const items: Readonly<Record<string, unknown>>[] = [];
      let nextCursor: Extract<ObserveTailCursor, { readonly kind: typeof kind }> | null = null;
      for (let index = start; index < files.length; index += 1) {
        const file = files[index]!,
          initialOffset = index === start ? (requested?.offset ?? 0) : 0,
          scanned = await scanLogFile(file, initialOffset, pageSize - items.length);
        if (scanned.outOfRange) return gap(kind, "cursor-offset-out-of-range", requested?.fileId ?? file.fileId);
        items.push(...scanned.items);
        nextCursor = { kind, fileId: file.fileId, offset: scanned.offset };
        if (items.length === pageSize) {
          const sourceCursor = await retainedEndCursor(kind, files);
          return {
            status: "ready",
            items,
            cursor: nextCursor,
            sourceCursor,
            done: sameCursor(nextCursor, sourceCursor),
          };
        }
        if (scanned.partial && index < files.length - 1)
          throw observeError(
            "log_record_invalid",
            `Retained log ${path.basename(file.path)} ends with a partial line.`,
          );
      }
      const sourceCursor = await retainedEndCursor(kind, files);
      return { status: "ready", items, cursor: nextCursor, sourceCursor, done: sameCursor(nextCursor, sourceCursor) };
    } catch (error) {
      if (error instanceof TailSnapshotChanged && attempt === 0) continue;
      throw error;
    }
  }
  throw observeError("log_snapshot_unstable", "Log files kept rotating while the tail snapshot was read; retry.");
}

function repoLogFiles(rootDir: string): readonly TailFile[] {
  const live = daemonRequestLogPath(rootDir),
    dir = path.dirname(live),
    base = path.basename(live),
    pattern = new RegExp(`^${escapeRegExp(base)}(?:\\.(\\d+))?$`, "u");
  return snapshotFiles(dir, (name) => {
    const match = pattern.exec(name);
    return match ? ["repo", Number(match[1] ?? 0)] : null;
  });
}

function daemonLogFiles(userRoot: string, daemonId: string): readonly TailFile[] {
  const dir = path.join(userRoot, "logs"),
    stem = daemonConnLogFileStem(daemonId),
    pattern = new RegExp(`^${escapeRegExp(stem)}(\\d{8})\\.jsonl(?:\\.(\\d+))?$`, "u");
  return snapshotFiles(dir, (name) => {
    const match = pattern.exec(name);
    return match ? [match[1]!, Number(match[2] ?? 0)] : null;
  });
}

function snapshotFiles(dir: string, orderOf: (name: string) => readonly [string, number] | null): readonly TailFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (observeFsErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  return names
    .flatMap((name): TailFile[] => {
      const order = orderOf(name);
      if (!order) return [];
      const filePath = path.join(dir, name);
      try {
        const stat = statSync(filePath, { bigint: true });
        return stat.isFile() ? [{ path: filePath, fileId: fileIdentity(stat), order }] : [];
      } catch (error) {
        if (observeFsErrorCode(error) === "ENOENT") return [];
        throw error;
      }
    })
    .sort((left, right) => left.order[0].localeCompare(right.order[0]) || right.order[1] - left.order[1]);
}

async function retainedEndCursor(
  kind: "repo-log" | "daemon-log",
  files: readonly TailFile[],
): Promise<Extract<ObserveTailCursor, { readonly kind: typeof kind }>> {
  const last = files.at(-1)!,
    opened = await openStableFile(last);
  try {
    const buffer = Buffer.allocUnsafe(Math.min(readChunkBytes, Math.max(opened.size, 1)));
    let end = opened.size;
    while (end > 0) {
      const start = Math.max(0, end - buffer.length),
        length = end - start;
      await readExactAt(opened.handle, buffer, length, start);
      const finalNewline = buffer.subarray(0, length).lastIndexOf(0x0a);
      if (finalNewline >= 0) return { kind, fileId: last.fileId, offset: start + finalNewline + 1 };
      end = start;
    }
    return { kind, fileId: last.fileId, offset: 0 };
  } finally {
    await opened.handle.close();
  }
}

async function scanLogFile(
  file: TailFile,
  initialOffset: number,
  limit: number,
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
        if (line.length > 0) items.push(parseLogRecord(file.path, line));
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

async function openStableFile(file: TailFile): Promise<{ readonly handle: FileHandle; readonly size: number }> {
  let handle: FileHandle;
  try {
    handle = await open(file.path, "r");
  } catch (error) {
    if (observeFsErrorCode(error) === "ENOENT") throw new TailSnapshotChanged();
    throw error;
  }
  try {
    const current = await handle.stat({ bigint: true });
    if (fileIdentity(current) !== file.fileId) throw new TailSnapshotChanged();
    const size = Number(current.size);
    if (!Number.isSafeInteger(size)) throw observeError("log_file_too_large", "Retained log size is not seekable.");
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

function parseLogRecord(filePath: string, bytes: Buffer): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw observeError(
      "log_record_invalid",
      `Retained log ${path.basename(filePath)} contains invalid UTF-8 JSON: ${detail}.`,
    );
  }
  if (!isJsonObject(value))
    throw observeError("log_record_invalid", `Retained log ${path.basename(filePath)} contains a non-object record.`);
  return value;
}

function edgeCenterRevision(rootDir: string, repoId: string): number | null {
  const config = readFleetEdgeConfig(rootDir);
  return config?.repoId === repoId ? (locateFleetMirrorView(config.viewRoot, repoId)?.revision ?? null) : null;
}

function gap(
  kind: "repo-log" | "daemon-log",
  reason: "cursor-file-not-retained" | "cursor-offset-out-of-range",
  requestedFileId: string,
): Extract<LogTailPage, { readonly status: "gap" }> {
  return {
    status: "gap",
    items: [],
    cursor: null,
    sourceCursor: null,
    done: false,
    gap: { reason, requestedFileId },
  };
}

function sameCursor(left: ObserveTailCursor | null, right: ObserveTailCursor | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fileIdentity(stat: BigIntStats): string {
  return `${stat.dev.toString(36)}:${stat.ino.toString(36)}:${stat.birthtimeNs.toString(36)}`;
}

function observeFsErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function observeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

class TailSnapshotChanged extends Error {}

type LogTailPage =
  | Pick<
      Extract<ObserveTailResult, { readonly status: "ready" | "pending" }>,
      "status" | "items" | "cursor" | "sourceCursor" | "done"
    >
  | Pick<
      Extract<ObserveTailResult, { readonly status: "gap" }>,
      "status" | "items" | "cursor" | "sourceCursor" | "done" | "gap"
    >;
