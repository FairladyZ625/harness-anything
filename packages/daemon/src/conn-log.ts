import { mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";

// Connection- and request-level observability for the daemon transport surface. The 2026-08-20
// connection-flood postmortem (fact F-A4858645) could not recover open/close events, active
// counts, or method timings from lifecycle logs, so this sink records them. Local-only, rolls
// over by day and size, never carries request payloads. Unlike lifecycle-log, every write goes
// through fs/promises on a serialized async chain: request dispatch never blocks on disk, and
// past a pending-line cap new records are dropped instead of queued.
export const DAEMON_CONN_LOG_SCHEMA = Object.freeze({ id: "daemon-conn-log/v1" });
const defaultMaxBytes = 8 * 1024 * 1024;
const defaultKeptDays = 7;
// Backstop for a wedged disk: an observability line may be lost; request handling may not stall.
const maxPendingLines = 10_000;

export interface DaemonConnLogOptions {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly maxBytes?: number;
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
  /** Repository selected by the request, when the protocol params carried one. */
  readonly repoId?: string | null;
  /** Protocol command/action id when the request resolves one; method remains the transport fallback. */
  readonly command?: string | null;
  /** Resolved caller identity (agent id or authenticated principal) when available. */
  readonly actor?: string | null;
  /** True for requests whose completion is intentionally deferred or polled by the caller. */
  readonly wait?: boolean;
  readonly startedAt: number;
  readonly frameReceivedAt?: number;
  readonly handlerStartedAt?: number;
  readonly repliedAt?: number;
  readonly dispatchDelayMs?: number;
  /** Main-thread scheduling delay observed when this frame was first read; explains a widened queue wait. */
  readonly eventLoopStallMs?: number;
  readonly requestBytes?: number;
  readonly replyBytes?: number;
  /** Authenticated fleet node that sent the frame; null for local CLI/GUI connections. */
  readonly nodeId?: string | null;
  /** OpenTelemetry-compatible ids and closed stage windows for this request. */
  readonly traceId?: string | null;
  readonly spanId?: string | null;
  readonly phases?: readonly { readonly name: string; readonly startedAtMs: number; readonly endedAtMs: number }[];
  readonly serviceMs?: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly code: string | null;
  readonly detail: string | null;
}

export interface DaemonConnLog {
  readonly connectionOpened: (conn: string, transport: string) => string;
  readonly connectionClosed: (conn: string) => void;
  readonly request: (entry: DaemonTrafficLogEntry) => void;
  // Drains queued appends (looping until no racing line extends the chain) and closes the handle on
  // the write chain itself, so shutdown leaks no descriptor. Appends after settlement are dropped.
  readonly settle: () => Promise<void>;
}

export function daemonConnLogFileStem(daemonId: string): string {
  return `daemon-${safeConnRuntimeId(daemonId)}-conn-`;
}

export function openDaemonConnLog(options: DaemonConnLogOptions): DaemonConnLog {
  const logDir = path.join(options.userRoot, "logs"),
    stem = daemonConnLogFileStem(options.daemonId),
    maxBytes = options.maxBytes ?? defaultMaxBytes,
    keptDays = options.keptDays ?? defaultKeptDays,
    now = options.now ?? (() => new Date()),
    pid = process.pid;
  let chain: Promise<void> = Promise.resolve(),
    pending = 0,
    dropped = 0,
    reportedFailure = false;
  let settled = false;
  let handle: FileHandle | null = null,
    fileBase = "",
    openDay = "",
    bytes = 0,
    nextSeq = 0,
    active = 0;
  const seqByConnId = new Map<string, number>(),
    openedAt = new Map<number, number>(),
    requestsByConn = new Map<number, number>();
  const append = (record: Record<string, unknown>): void => {
    if (settled) return;
    const lines = [
      `${JSON.stringify({ schema: DAEMON_CONN_LOG_SCHEMA.id, at: now().toISOString(), daemonId: options.daemonId, pid, ...record })}\n`,
    ];
    if (dropped > 0) {
      lines.unshift(
        `${JSON.stringify({ schema: DAEMON_CONN_LOG_SCHEMA.id, at: now().toISOString(), daemonId: options.daemonId, pid, event: "dropped_lines", count: dropped })}\n`,
      );
      dropped = 0;
    }
    if (pending + lines.length > maxPendingLines) {
      dropped += lines.length;
      return;
    }
    pending += lines.length;
    for (const line of lines)
      chain = chain
        .then(() => writeLine(line))
        .then(
          () => {
            pending -= 1;
          },
          () => {
            pending -= 1;
          },
        );
  };
  return {
    connectionOpened: (conn, transport) => {
      const seq = (nextSeq += 1);
      seqByConnId.set(conn, seq);
      openedAt.set(seq, Date.parse(now().toISOString()));
      active += 1;
      append({ event: "conn_open", conn: connLabel(seq), transport, active });
      return connLabel(seq);
    },
    connectionClosed: (conn) => {
      const seq = seqByConnId.get(conn);
      if (seq === undefined) return;
      const started = openedAt.get(seq) ?? Date.parse(now().toISOString()),
        closed = Date.parse(now().toISOString()),
        requests = requestsByConn.get(seq) ?? 0;
      seqByConnId.delete(conn);
      openedAt.delete(seq);
      requestsByConn.delete(seq);
      active -= 1;
      append({ event: "conn_close", conn: connLabel(seq), active, durationMs: closed - started, requests });
    },
    request: (entry) => {
      const seq = seqOf(entry.conn);
      if (seq !== null) requestsByConn.set(seq, (requestsByConn.get(seq) ?? 0) + 1);
      const frameReceivedAt = entry.frameReceivedAt ?? entry.startedAt,
        handlerStartedAt = entry.handlerStartedAt ?? entry.startedAt,
        repliedAt = entry.repliedAt ?? entry.startedAt + entry.durationMs,
        dispatchDelayMs = entry.dispatchDelayMs ?? Math.max(0, handlerStartedAt - frameReceivedAt),
        serviceMs = entry.serviceMs ?? entry.durationMs;
      append({
        event: "request",
        conn: entry.conn,
        transport: entry.transport,
        method: entry.method,
        repoId: entry.repoId ?? null,
        command: entry.command ?? entry.method,
        actor: entry.actor ?? null,
        ...(entry.wait === true ? { wait: true } : {}),
        at: new Date(entry.startedAt).toISOString(),
        frameReceivedAt: new Date(frameReceivedAt).toISOString(),
        handlerStartedAt: new Date(handlerStartedAt).toISOString(),
        repliedAt: new Date(repliedAt).toISOString(),
        atEnd: new Date(repliedAt).toISOString(),
        dispatchDelayMs,
        ...(entry.eventLoopStallMs !== undefined && entry.eventLoopStallMs > 0
          ? { eventLoopStallMs: entry.eventLoopStallMs }
          : {}),
        requestBytes: entry.requestBytes ?? 0,
        replyBytes: entry.replyBytes ?? 0,
        nodeId: entry.nodeId ?? null,
        ...(entry.traceId ? { traceId: entry.traceId, spanId: entry.spanId ?? null } : {}),
        ...(entry.phases && entry.phases.length > 0 ? { phases: entry.phases } : {}),
        ...(entry.traceId
          ? {
              otel: {
                traceId: entry.traceId,
                spanId: entry.spanId ?? null,
                name: entry.method ?? "unknown",
                kind: "SERVER",
                startTimeUnixNano: unixNano(entry.startedAt),
                endTimeUnixNano: unixNano(repliedAt),
                status: { code: entry.ok ? 0 : 2 },
                attributes: [
                  { key: "daemon.method", value: { stringValue: entry.method ?? "unknown" } },
                  { key: "daemon.repo_id", value: { stringValue: entry.repoId ?? "" } },
                  { key: "daemon.node_id", value: { stringValue: entry.nodeId ?? "" } },
                  { key: "daemon.ok", value: { boolValue: entry.ok } },
                  { key: "daemon.request_bytes", value: { intValue: String(entry.requestBytes ?? 0) } },
                  { key: "daemon.reply_bytes", value: { intValue: String(entry.replyBytes ?? 0) } },
                ],
              },
            }
          : {}),
        serviceMs,
        durationMs: entry.durationMs,
        ok: entry.ok,
        code: entry.code,
        ...(!entry.ok ? { detail: entry.detail ?? "Unknown request failure." } : {}),
      });
    },
    settle: async () => {
      settled = true;
      let tail: Promise<void>;
      do {
        tail = chain;
        await tail;
      } while (tail !== chain);
      chain = chain.then(() => closeHandle());
      await chain;
    },
  };
  async function writeLine(line: string): Promise<void> {
    try {
      const day = dayStamp(now());
      if (!handle || day !== openDay) {
        await closeHandle();
        openDay = day;
        fileBase = path.join(logDir, `${stem}${day}.jsonl`);
        await /* @gate-identity non-state/environment-io.6d0e830b1d8e8184 */ mkdir(logDir, { recursive: true });
        await pruneOldDays();
        handle = await /* @gate-identity non-state/environment-io.322a27fbba962656 */ open(fileBase, "a");
        bytes = (await handle.stat()).size;
      }
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        // Shift the generation chain and keep writing to the base file: readers (observe.tail
        // live cursors) follow the base as the live file. Nothing is deleted within the day —
        // size rotation used to drop the oldest generation, which deleted live records whenever
        // one day's traffic exceeded maxBytes × kept generations (research 3: 2026-10-16).
        await closeHandle();
        await shiftDayGenerations(day);
        handle = await /* @gate-identity non-state/environment-io.8c335c7d3f5a6f60 */ open(fileBase, "a");
        bytes = 0;
      }
      bytes += (await handle!.write(line)).bytesWritten;
    } catch (error) {
      // Keep attempting later lines but report only the first failure, mirroring lifecycle-log.
      consumeKnownError(error);
      if (!reportedFailure) {
        reportedFailure = true;
        (options.onFailure ?? defaultConnFailureReporter)(error);
      }
      await closeHandle();
    }
  }
  async function shiftDayGenerations(day: string): Promise<void> {
    const base = path.join(logDir, `${stem}${day}.jsonl`),
      pattern = new RegExp(`^${escapeRegExp(stem)}${day}\\.jsonl\\.(\\d+)$`, "u");
    let names: string[];
    try {
      names = await readdir(logDir);
    } catch (error) {
      consumeKnownError(error);
      return;
    }
    const highest = names.reduce((max, name) => Math.max(max, Number(pattern.exec(name)?.[1] ?? 0)), 0);
    for (let index = highest; index >= 1; index -= 1) await renameIfExists(`${base}.${index}`, `${base}.${index + 1}`);
    await renameIfExists(base, `${base}.1`);
  }
  async function closeHandle(): Promise<void> {
    if (!handle) return;
    const closing = handle;
    handle = null;
    openDay = "";
    try {
      await closing.close();
    } catch (error) {
      consumeKnownError(error);
    }
  }
  async function pruneOldDays(): Promise<void> {
    const pattern = new RegExp(`^${escapeRegExp(stem)}(\\d{8})\\.jsonl(?:\\.\\d+)?$`, "u");
    let names: string[];
    try {
      names = await readdir(logDir);
    } catch (error) {
      consumeKnownError(error);
      return;
    }
    const days = new Set(names.flatMap((name) => pattern.exec(name)?.[1] ?? [])),
      keep = [...days].sort().slice(-keptDays);
    for (const name of names) {
      const day = pattern.exec(name)?.[1];
      if (day !== undefined && !keep.includes(day))
        await /* @gate-identity non-state/environment-io.772a233589a799c0 */ rm(path.join(logDir, name), {
          force: true,
        });
    }
  }
}

function seqOf(conn: string): number | null {
  const seq = /^c-(\d+)$/u.exec(conn)?.[1];
  return seq === undefined ? null : Number(seq);
}
function connLabel(seq: number): string {
  return `c-${seq}`;
}
function unixNano(atMs: number): string {
  return (BigInt(Math.round(atMs)) * 1_000_000n).toString();
}
function dayStamp(at: Date): string {
  return at.toISOString().slice(0, 10).replaceAll("-", "");
}
function safeConnRuntimeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
async function renameIfExists(from: string, to: string): Promise<void> {
  try {
    await /* @gate-identity non-state/environment-io.119a357bb4245a64 */ rename(from, to);
  } catch (error) {
    if (!isConnFileMissing(error)) throw error;
    consumeKnownError(error);
  }
}
function isConnFileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function defaultConnFailureReporter(error: unknown): void {
  process.stderr.write(
    `harness daemon: conn log write failure: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
