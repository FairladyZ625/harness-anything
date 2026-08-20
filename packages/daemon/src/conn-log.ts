import { mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";

// Connection- and request-level observability for the daemon transport surface. The 2026-08-20
// connection-flood postmortem (fact F-A4858645) could not recover open/close events, active
// counts, or method timings from lifecycle logs, so this sink records them. Local-only, rolls
// over by day and size, never carries request payloads. Unlike lifecycle-log, every write goes
// through fs/promises on a serialized async chain: request dispatch never blocks on disk, and
// past a pending-line cap new records are dropped instead of queued.
export const DAEMON_CONN_LOG_SCHEMA = Object.freeze({ id: "daemon-conn-log/v1" });
const defaultMaxBytes = 8 * 1024 * 1024;
const defaultKeptGenerations = 1;
const defaultKeptDays = 7;
// Backstop for a wedged disk: an observability line may be lost; request handling may not stall.
const maxPendingLines = 10_000;

export interface DaemonConnLogOptions {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly maxBytes?: number;
  readonly keptGenerations?: number;
  readonly keptDays?: number;
  readonly now?: () => Date;
  readonly onFailure?: (error: unknown) => void;
}

// Emitted by the protocol server per JSON-RPC request, hello included; conn is the monotonic
// connection id handed out by connectionOpened.
export interface DaemonTrafficLogEntry {
  readonly conn: string;
  readonly transport: string;
  readonly method: string | null;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly code: string | null;
}

export interface DaemonConnLog {
  readonly connectionOpened: (conn: string, transport: string) => string;
  readonly connectionClosed: (conn: string) => void;
  readonly request: (entry: DaemonTrafficLogEntry) => void;
  // Awaits queued appends so buffered lines survive daemon shutdown.
  readonly settle: () => Promise<void>;
}

export function daemonConnLogFileStem(daemonId: string): string { return `daemon-${safeRuntimeId(daemonId)}-conn-`; }

export function openDaemonConnLog(options: DaemonConnLogOptions): DaemonConnLog {
  const logDir = path.join(options.userRoot, "logs"), stem = daemonConnLogFileStem(options.daemonId),
    maxBytes = options.maxBytes ?? defaultMaxBytes, keptGenerations = options.keptGenerations ?? defaultKeptGenerations,
    keptDays = options.keptDays ?? defaultKeptDays, now = options.now ?? (() => new Date()), pid = process.pid;
  let chain: Promise<void> = Promise.resolve(), pending = 0, dropped = 0, reportedFailure = false;
  let handle: FileHandle | null = null, fileBase = "", openDay = "", bytes = 0, nextSeq = 0, active = 0;
  const seqByConnId = new Map<string, number>(), openedAt = new Map<number, number>(), requestsByConn = new Map<number, number>();
  const append = (record: Record<string, unknown>): void => {
    const lines = [`${JSON.stringify({ schema: DAEMON_CONN_LOG_SCHEMA.id, at: now().toISOString(), daemonId: options.daemonId, pid, ...record })}\n`];
    if (dropped > 0) { lines.unshift(`${JSON.stringify({ schema: DAEMON_CONN_LOG_SCHEMA.id, at: now().toISOString(), daemonId: options.daemonId, pid, event: "dropped_lines", count: dropped })}\n`); dropped = 0; }
    if (pending + lines.length > maxPendingLines) { dropped += lines.length; return; }
    pending += lines.length;
    for (const line of lines) chain = chain.then(() => writeLine(line)).then(() => { pending -= 1; }, () => { pending -= 1; });
  };
  return {
    connectionOpened: (conn, transport) => { const seq = nextSeq += 1; seqByConnId.set(conn, seq); openedAt.set(seq, Date.parse(now().toISOString())); active += 1; append({ event: "conn_open", conn: connLabel(seq), transport, active }); return connLabel(seq); },
    connectionClosed: (conn) => { const seq = seqByConnId.get(conn); if (seq === undefined) return; const started = openedAt.get(seq) ?? Date.parse(now().toISOString()), closed = Date.parse(now().toISOString()), requests = requestsByConn.get(seq) ?? 0; seqByConnId.delete(conn); openedAt.delete(seq); requestsByConn.delete(seq); active -= 1; append({ event: "conn_close", conn: connLabel(seq), active, durationMs: closed - started, requests }); },
    request: (entry) => { const seq = seqOf(entry.conn); if (seq !== null) requestsByConn.set(seq, (requestsByConn.get(seq) ?? 0) + 1); append({ event: "request", conn: entry.conn, transport: entry.transport, method: entry.method, at: new Date(entry.startedAt).toISOString(), atEnd: new Date(entry.startedAt + entry.durationMs).toISOString(), durationMs: entry.durationMs, ok: entry.ok, code: entry.code }); },
    settle: async () => { await chain; }
  };
  async function writeLine(line: string): Promise<void> {
    try {
      const day = dayStamp(now());
      if (!handle || day !== openDay) { await closeHandle(); openDay = day; fileBase = path.join(logDir, `${stem}${day}.jsonl`); await mkdir(logDir, { recursive: true }); await pruneOldDays(); handle = await open(fileBase, "a"); bytes = (await handle.stat()).size; }
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        await closeHandle();
        if (keptGenerations < 1) await rm(fileBase, { force: true });
        else { await rm(`${fileBase}.${keptGenerations}`, { force: true }); for (let index = keptGenerations - 1; index >= 1; index -= 1) await renameIfExists(`${fileBase}.${index}`, `${fileBase}.${index + 1}`); await renameIfExists(fileBase, `${fileBase}.1`); }
        handle = await open(fileBase, "a"); bytes = 0;
      }
      bytes += (await handle!.write(line)).bytesWritten;
    } catch (error) {
      // Keep attempting later lines but report only the first failure, mirroring lifecycle-log.
      consumeKnownError(error); if (!reportedFailure) { reportedFailure = true; (options.onFailure ?? defaultFailureReporter)(error); }
      await closeHandle();
    }
  }
  async function closeHandle(): Promise<void> { if (!handle) return; const closing = handle; handle = null; openDay = ""; try { await closing.close(); } catch (error) { consumeKnownError(error); } }
  async function pruneOldDays(): Promise<void> {
    const pattern = new RegExp(`^${escapeRegExp(stem)}(\\d{8})\\.jsonl(?:\\.\\d+)?$`, "u"); let names: string[];
    try { names = await readdir(logDir); } catch (error) { consumeKnownError(error); return; }
    const days = new Set(names.flatMap((name) => pattern.exec(name)?.[1] ?? [])), keep = [...days].sort().slice(-keptDays);
    for (const name of names) { const day = pattern.exec(name)?.[1]; if (day !== undefined && !keep.includes(day)) await rm(path.join(logDir, name), { force: true }); }
  }
  async function renameIfExists(from: string, to: string): Promise<void> { try { await rename(from, to); } catch (error) { if (!isMissing(error)) throw error; consumeKnownError(error); } }
}

function seqOf(conn: string): number | null { const seq = /^c-(\d+)$/u.exec(conn)?.[1]; return seq === undefined ? null : Number(seq); }
function connLabel(seq: number): string { return `c-${seq}`; }
function dayStamp(at: Date): string { return at.toISOString().slice(0, 10).replaceAll("-", ""); }
function safeRuntimeId(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/gu, "-"); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function defaultFailureReporter(error: unknown): void { process.stderr.write(`harness daemon: conn log write failure: ${error instanceof Error ? error.message : String(error)}\n`); }
