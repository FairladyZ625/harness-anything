import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  resolveHarnessLayout,
  type ActorIdentity,
  type WriteSource,
} from "../../kernel/src/index.ts";
import type { RuntimePermissionMode } from "./runtime-permissions.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "./runtime-fallback-contract.ts";

const streamSchema = "runtime-dispatch-stream/v1" as const;
const liveIndexSchema = "runtime-dispatch-live-index/v1" as const;
const forbiddenKey =
  /(?:token|credential|password|secret|authorization|executablepath|api[-_ ]?key|private[-_ ]?key|cookie)/iu;
const bearer = /\bBearer\s+[^\s,;]+/giu;
const knownToken = /\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}\b/giu;
const sensitiveAssignment =
  /\b(?:authorization|cookie|credential(?:Ref)?|executablePath|api[-_ ]?key|accessToken|apiToken|password|private[-_ ]?key|secret|token)\s*[:=]\s*[^\s,;}]+/giu;

export interface DispatchStreamHeader {
  readonly schema: typeof streamSchema;
  readonly kind: "dispatch";
  readonly dispatchId: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly leaseVersion?: number;
  readonly schedule?: { readonly scheduleId: string; readonly claimFence: string };
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly eventStreamRef: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly delegatedByAgentId?: string;
  readonly delegatedByAgentName?: string;
  readonly squadId?: string;
  readonly parentRuntimeSessionId?: string;
  readonly onExitCommand?: string;
  readonly dispatchOpId?: string;
  readonly kindId?: "claude" | "codex" | "agy";
  readonly permissionMode?: RuntimePermissionMode | null;
  readonly binding?: { readonly actor: ActorIdentity; readonly source: WriteSource };
  readonly cwd?: string;
  readonly prompt?: string;
  readonly promptSource?: string;
  readonly model?: string;
  readonly reasoningEffort?: string | null;
  readonly resumeProviderSessionId?: string | null;
  readonly mission?: string;
  readonly fallbackAttempt?: RuntimeFallbackAttempt;
}

export type DispatchStreamRecord = Record<string, unknown>;
export type DispatchProcessState = {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly exited: boolean;
};

export interface DispatchStreamWriter {
  readonly ref: string;
  readonly appendProviderEvent: (value: unknown, occurredAt: string) => void;
  readonly appendProviderBinding: (providerSessionId: string, occurredAt: string) => void;
  readonly appendExitNotification: (
    value: {
      readonly phase: "started" | "finished";
      readonly started: boolean;
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly errorCode?: string;
    },
    occurredAt: string,
  ) => void;
  readonly appendAttemptOutcome: (value: RuntimeAttemptOutcome, occurredAt: string) => void;
  readonly appendFallbackState: (
    value:
      | {
          readonly state: "scheduled";
          readonly delayMs: number;
          readonly notBeforeAt: string;
          readonly nextProvider: { readonly instance: string; readonly model?: string };
        }
      | { readonly state: "dispatched"; readonly nextDispatchId: string; readonly nextRuntimeSessionId: string }
      | { readonly state: "exhausted"; readonly reason: string },
    occurredAt: string,
  ) => void;
}

export interface DispatchLiveIndexEntry {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly runtimeSessionId: string;
}

export interface DispatchLiveIndex {
  readonly schema: typeof liveIndexSchema;
  readonly entries: readonly DispatchLiveIndexEntry[];
}

/** Metadata needed by daemon hot paths without retaining provider event bodies. */
export type DispatchStreamSummary = Omit<NonNullable<ReturnType<typeof readDispatchStream>>, "records"> & {
  readonly records: readonly DispatchStreamRecord[];
};

type SummaryCacheEntry = {
  readonly mtimeMs: number;
  readonly size: number;
  readonly value: DispatchStreamSummary | null;
};

const summaryCache = new Map<string, SummaryCacheEntry>();
const summaryHeadBytes = 16 * 1024;
const summaryTailBytes = 128 * 1024;
const summaryKinds = new Set([
  "provider_binding",
  "process_started",
  "process_exit",
  "process_lost",
  "attempt_outcome",
  "fallback_state",
  "squad_run_state",
]);

export function openDispatchStream(
  rootDir: string,
  header: Omit<DispatchStreamHeader, "schema" | "kind" | "eventStreamRef">,
): DispatchStreamWriter {
  const ref = dispatchStreamRef(rootDir, header.dispatchId),
    target = dispatchStreamPath(rootDir, header.dispatchId);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    const record = { schema: streamSchema, kind: "dispatch", ...header, eventStreamRef: ref };
    writeFileSync(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    if (header.taskId) {
      try {
        upsertDispatchLiveIndex(rootDir, {
          dispatchId: header.dispatchId,
          taskId: header.taskId,
          runtimeSessionId: header.runtimeSessionId,
        });
      } catch (error) {
        unlinkSync(target);
        throw error;
      }
    }
  }
  return {
    ref,
    appendProviderEvent: (value, occurredAt) =>
      appendJsonl(target, {
        schema: streamSchema,
        kind: "provider_event",
        occurredAt,
        event: scrubProviderValue(value),
      }),
    appendProviderBinding: (providerSessionId, occurredAt) =>
      appendJsonl(target, { schema: streamSchema, kind: "provider_binding", occurredAt, providerSessionId }),
    appendExitNotification: (value, occurredAt) =>
      appendJsonl(target, { schema: streamSchema, kind: "exit_notification", occurredAt, ...value }),
    appendAttemptOutcome: (value, occurredAt) =>
      appendJsonl(target, { schema: streamSchema, kind: "attempt_outcome", occurredAt, ...value }),
    appendFallbackState: (value, occurredAt) =>
      appendJsonl(target, { schema: streamSchema, kind: "fallback_state", occurredAt, ...value }),
  };
}

export function reopenDispatchStream(rootDir: string, header: DispatchStreamHeader): DispatchStreamWriter {
  const { schema: _schema, kind: _kind, eventStreamRef: _eventStreamRef, ...stored } = header;
  return openDispatchStream(rootDir, stored);
}

export function removeDispatchStream(rootDir: string, dispatchId: string): void {
  const target = dispatchStreamPath(rootDir, dispatchId),
    header = readDispatchStreamHeader(rootDir, dispatchId);
  summaryCache.delete(target);
  if (existsSync(target)) unlinkSync(target);
  if (header?.taskId)
    removeDispatchLiveIndexEntries(rootDir, [
      { dispatchId, taskId: header.taskId, runtimeSessionId: header.runtimeSessionId },
    ]);
}

export function readDispatchLiveIndex(rootDir: string, taskIds: readonly string[]): DispatchLiveIndex {
  const entries: DispatchLiveIndexEntry[] = [],
    missing: string[] = [];
  for (const taskId of new Set(taskIds)) {
    const stored = readStoredDispatchLiveIndex(dispatchLiveIndexPath(rootDir, taskId), taskId);
    if (stored) entries.push(...stored.entries);
    else missing.push(taskId);
  }
  if (missing.length > 0) entries.push(...rebuildDispatchLiveIndex(rootDir, missing).entries);
  return dispatchLiveIndex(entries);
}

export function rebuildDispatchLiveIndex(rootDir: string, taskIds: readonly string[]): DispatchLiveIndex {
  const root = dispatchStreamRoot(rootDir),
    selected = new Set(taskIds);
  const entries = new Map<string, DispatchLiveIndexEntry>();
  if (existsSync(root) && statSync(root).isDirectory()) {
    for (const name of readdirSync(root).filter((value) => /^dispatch_[a-f0-9]{24}\.jsonl$/u.test(value))) {
      const header = readDispatchStreamHeader(rootDir, name.slice(0, -6));
      if (!header?.taskId || !selected.has(header.taskId)) continue;
      entries.set(header.dispatchId, {
        dispatchId: header.dispatchId,
        taskId: header.taskId,
        runtimeSessionId: header.runtimeSessionId,
      });
    }
  }
  const rebuilt = dispatchLiveIndex([...entries.values()]);
  for (const taskId of selected) {
    const owned = rebuilt.entries.filter((entry) => entry.taskId === taskId);
    writeDispatchLiveIndex(rootDir, taskId, dispatchLiveIndex(owned));
  }
  return rebuilt;
}

export function removeDispatchLiveIndexEntries(rootDir: string, removals: readonly DispatchLiveIndexEntry[]): void {
  const byTask = new Map<string, Set<string>>();
  for (const removal of removals) {
    byTask.set(removal.taskId, (byTask.get(removal.taskId) ?? new Set()).add(removal.dispatchId));
  }
  for (const [taskId, dispatchIds] of byTask) {
    const stored = readStoredDispatchLiveIndex(dispatchLiveIndexPath(rootDir, taskId), taskId);
    if (!stored) continue;
    const entries = stored.entries.filter((entry) => !dispatchIds.has(entry.dispatchId));
    if (entries.length !== stored.entries.length) writeDispatchLiveIndex(rootDir, taskId, dispatchLiveIndex(entries));
  }
}

export function readDispatchStreamHeader(rootDir: string, dispatchId: string): DispatchStreamHeader | null {
  const target = dispatchStreamPath(rootDir, dispatchId);
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const descriptor = openSync(target, fsConstants.O_RDONLY),
    chunks: Buffer[] = [];
  try {
    while (true) {
      const chunk = Buffer.alloc(4096),
        read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const newline = chunk.subarray(0, read).indexOf(10);
      chunks.push(chunk.subarray(0, newline === -1 ? read : newline));
      if (newline !== -1) break;
    }
  } finally {
    closeSync(descriptor);
  }
  const first = parseRecord(Buffer.concat(chunks).toString("utf8").replace(/\r$/u, ""));
  return isHeader(first) && first.dispatchId === dispatchId ? first : null;
}

/**
 * Read lifecycle metadata without loading provider output. Lifecycle records are
 * written at the head or tail of a stream; the bounded windows keep daemon
 * scans proportional to stream count rather than provider transcript size.
 */
export function readDispatchStreamSummary(rootDir: string, dispatchId: string): DispatchStreamSummary | null {
  const target = dispatchStreamPath(rootDir, dispatchId);
  if (!existsSync(target) || !statSync(target).isFile()) {
    summaryCache.delete(target);
    return null;
  }
  const stat = statSync(target),
    cached = summaryCache.get(target);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  const header = readDispatchStreamHeader(rootDir, dispatchId);
  if (!header) {
    summaryCache.set(target, { mtimeMs: stat.mtimeMs, size: stat.size, value: null });
    return null;
  }
  const headerEnd = firstLineEndOffset(target, stat.size);
  const chunks = readBoundedStreamWindows(target, stat.size, headerEnd),
    records: DispatchStreamRecord[] = [];
  const seenOffsets = new Set<number>();
  for (const chunk of chunks) {
    for (const line of completeLines(chunk.text, chunk.offset, stat.size)) {
      if (line.offset === 0 || seenOffsets.has(line.offset)) continue;
      seenOffsets.add(line.offset);
      const kind = lineKind(line.value);
      if (!kind || !summaryKinds.has(kind)) continue;
      const record = parseRecord(line.value);
      if (record) records.push(record);
    }
  }
  const value = summarizeDispatch(header, records);
  summaryCache.set(target, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

export function readDispatchStreamHeaders(rootDir: string): readonly DispatchStreamHeader[] {
  const root = dispatchStreamRoot(rootDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root)
    .filter((name) => /^dispatch_[a-f0-9]{24}\.jsonl$/u.test(name))
    .map((name) => readDispatchStreamHeader(rootDir, name.slice(0, -6)))
    .filter((header): header is DispatchStreamHeader => header !== null);
}

export function readDispatchStreamSummaries(rootDir: string): readonly DispatchStreamSummary[] {
  return readDispatchStreamHeaders(rootDir)
    .map((header) => readDispatchStreamSummary(rootDir, header.dispatchId))
    .filter((stream): stream is DispatchStreamSummary => stream !== null);
}

export function readDispatchStream(
  rootDir: string,
  dispatchId: string,
): {
  readonly header: DispatchStreamHeader;
  readonly providerSessionId: string | null;
  readonly process: DispatchProcessState | null;
  readonly attemptOutcome: RuntimeAttemptOutcome | null;
  readonly fallbackState: "scheduled" | "dispatched" | "exhausted" | null;
  readonly fallbackSchedule: {
    readonly notBeforeAt: string;
    readonly nextProvider: { readonly instance: string; readonly model?: string };
  } | null;
  readonly nextDispatchId: string | null;
  readonly records: readonly DispatchStreamRecord[];
} | null {
  const target = dispatchStreamPath(rootDir, dispatchId);
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const lines = readFileSync(target, "utf8").split(/\r?\n/u).filter(Boolean),
    first = parseRecord(lines[0]);
  if (!isHeader(first) || first.dispatchId !== dispatchId) return null;
  const records = lines
    .slice(1)
    .map(parseRecord)
    .filter((record): record is DispatchStreamRecord => record !== null);
  const summary = summarizeDispatch(first, records);
  return {
    ...summary,
    records,
  };
}

function isFallbackProvider(value: unknown): value is { readonly instance: string; readonly model?: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { readonly instance?: unknown }).instance === "string" &&
    ((value as { readonly model?: unknown }).model === undefined ||
      typeof (value as { readonly model?: unknown }).model === "string")
  );
}

export function appendRuntimeWorkerRecord(
  rootDir: string,
  dispatchId: string,
  value: Readonly<Record<string, unknown>>,
): void {
  appendJsonl(dispatchStreamPath(rootDir, dispatchId), { schema: streamSchema, ...value });
}

export function readRuntimeWorkerChunk(
  rootDir: string,
  dispatchId: string,
  offset: number,
  limit = 1024 * 1024,
): Buffer {
  const descriptor = openSync(dispatchStreamPath(rootDir, dispatchId), fsConstants.O_RDONLY);
  try {
    const size = fstatSync(descriptor).size;
    if (size <= offset) return Buffer.alloc(0);
    const bytes = Buffer.alloc(Math.min(size - offset, limit));
    const read = readSync(descriptor, bytes, 0, bytes.length, offset);
    return bytes.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

export function dispatchStreamRef(rootDir: string, dispatchId: string): string {
  const relative = path
    .relative(resolveHarnessLayout(rootDir).rootDir, dispatchStreamPath(rootDir, dispatchId))
    .split(path.sep)
    .join("/");
  return `file:${relative}`;
}

export function scrubProviderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubProviderValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !forbiddenKey.test(key))
        .map(([key, entry]) => [key, scrubProviderValue(entry)]),
    );
  if (typeof value !== "string") return value;
  return value
    .replace(bearer, "Bearer [REDACTED]")
    .replace(knownToken, "[REDACTED]")
    .replace(sensitiveAssignment, "[REDACTED]");
}

export function dispatchStreamPath(rootDir: string, dispatchId: string): string {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) throw new Error("dispatch id is invalid");
  return path.join(dispatchStreamRoot(rootDir), `${dispatchId}.jsonl`);
}
export function dispatchLiveIndexPath(rootDir: string, taskId: string): string {
  const shard = `task-${Buffer.from(taskId).toString("base64url")}.json`;
  return path.join(dispatchStreamRoot(rootDir), "live-index", shard);
}
function dispatchStreamRoot(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, "runtime", "dispatches");
}

function dispatchLiveIndex(entries: readonly DispatchLiveIndexEntry[]): DispatchLiveIndex {
  const sorted = [...entries].sort((left, right) => left.dispatchId.localeCompare(right.dispatchId));
  return { schema: liveIndexSchema, entries: sorted };
}
function upsertDispatchLiveIndex(rootDir: string, entry: DispatchLiveIndexEntry): void {
  const current = readDispatchLiveIndex(rootDir, [entry.taskId]);
  const entries = new Map(current.entries.map((value) => [value.dispatchId, value]));
  entries.set(entry.dispatchId, entry);
  writeDispatchLiveIndex(rootDir, entry.taskId, dispatchLiveIndex([...entries.values()]));
}
function writeDispatchLiveIndex(rootDir: string, taskId: string, index: DispatchLiveIndex): void {
  const target = dispatchLiveIndexPath(rootDir, taskId),
    temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function readStoredDispatchLiveIndex(target: string, taskId: string): DispatchLiveIndex | null {
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (!isDispatchIndexRecord(parsed) || parsed.schema !== liveIndexSchema) return null;
    if (!Array.isArray(parsed.entries)) return null;
    const entries: DispatchLiveIndexEntry[] = [];
    for (const value of parsed.entries) {
      if (!isDispatchIndexRecord(value) || value.taskId !== taskId) return null;
      const dispatchId = String(value.dispatchId),
        runtimeSessionId = value.runtimeSessionId;
      if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) return null;
      if (typeof runtimeSessionId !== "string") return null;
      entries.push({ dispatchId, taskId: value.taskId, runtimeSessionId });
    }
    return dispatchLiveIndex(entries);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
function appendJsonl(target: string, value: unknown): void {
  summaryCache.delete(target);
  const descriptor = openSync(target, fsConstants.O_APPEND | fsConstants.O_WRONLY);
  try {
    writeFileSync(descriptor, `${JSON.stringify(scrubProviderValue(value))}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function summarizeDispatch(
  header: DispatchStreamHeader,
  records: readonly DispatchStreamRecord[],
): DispatchStreamSummary {
  let providerSessionId: string | null = null,
    processState: DispatchProcessState | null = null,
    attemptOutcome: RuntimeAttemptOutcome | null = null,
    fallbackState: "scheduled" | "dispatched" | "exhausted" | null = null,
    fallbackSchedule: DispatchStreamSummary["fallbackSchedule"] = null,
    nextDispatchId: string | null = null;
  for (const record of records) {
    if (record.kind === "provider_binding" && typeof record.providerSessionId === "string")
      providerSessionId = record.providerSessionId;
    if (record.kind === "process_started" && Number.isInteger(record.pid) && Number(record.pid) > 0)
      processState = { pid: Number(record.pid), exitCode: null, signal: null, exited: false };
    if (record.kind === "process_exit" && processState)
      processState = {
        ...processState,
        exitCode: Number.isInteger(record.exitCode) ? Number(record.exitCode) : null,
        signal: typeof record.signal === "string" ? record.signal : null,
        exited: true,
      };
    if (record.kind === "attempt_outcome" && isRuntimeAttemptOutcome(record)) attemptOutcome = record;
    if (record.kind === "fallback_state" && ["scheduled", "dispatched", "exhausted"].includes(String(record.state))) {
      fallbackState = record.state as typeof fallbackState;
      fallbackSchedule =
        record.state === "scheduled" &&
        typeof record.notBeforeAt === "string" &&
        isFallbackProvider(record.nextProvider)
          ? { notBeforeAt: record.notBeforeAt, nextProvider: record.nextProvider }
          : null;
      nextDispatchId = typeof record.nextDispatchId === "string" ? record.nextDispatchId : nextDispatchId;
    }
  }
  return {
    header,
    providerSessionId,
    process: processState,
    attemptOutcome,
    fallbackState,
    fallbackSchedule,
    nextDispatchId,
    records,
  };
}

function readBoundedStreamWindows(
  target: string,
  size: number,
  headerEnd: number,
): readonly { offset: number; text: string }[] {
  const descriptor = openSync(target, fsConstants.O_RDONLY);
  try {
    const windows = [
      { offset: 0, length: Math.min(size, summaryHeadBytes) },
      ...(headerEnd < size ? [{ offset: headerEnd, length: Math.min(size - headerEnd, summaryHeadBytes) }] : []),
    ];
    if (size > summaryHeadBytes)
      windows.push({ offset: Math.max(0, size - summaryTailBytes), length: Math.min(size, summaryTailBytes) });
    return windows.map(({ offset, length }) => {
      const bytes = Buffer.alloc(length),
        read = readSync(descriptor, bytes, 0, length, offset);
      return { offset, text: bytes.subarray(0, read).toString("utf8") };
    });
  } finally {
    closeSync(descriptor);
  }
}

function firstLineEndOffset(target: string, size: number): number {
  const descriptor = openSync(target, fsConstants.O_RDONLY);
  try {
    let offset = 0;
    while (offset < size) {
      const bytes = Buffer.alloc(Math.min(4096, size - offset));
      const read = readSync(descriptor, bytes, 0, bytes.length, offset);
      if (read === 0) return size;
      const newline = bytes.subarray(0, read).indexOf(10);
      if (newline !== -1) return offset + newline + 1;
      offset += read;
    }
    return size;
  } finally {
    closeSync(descriptor);
  }
}

function completeLines(text: string, offset: number, size: number): readonly { offset: number; value: string }[] {
  const lines = text.split(/\r?\n/u),
    result: { offset: number; value: string }[] = [];
  let cursor = offset;
  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]!;
    const end = cursor + Buffer.byteLength(value) + 1;
    if (index > 0 && cursor === offset) {
      cursor = end;
      continue;
    }
    if (end > size && index === lines.length - 1) break;
    if (value.trim()) result.push({ offset: cursor, value });
    cursor = end;
  }
  return result;
}

function lineKind(value: string): string | null {
  const match = /"kind"\s*:\s*"([^"\\]+)"/u.exec(value);
  return match?.[1] ?? null;
}
function parseRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
function isDispatchIndexRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isRuntimeAttemptOutcome(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RuntimeAttemptOutcome {
  const provider = value.provider;
  return (
    ["provider_fault", "worker_stop", "gate_red"].includes(String(value.classification)) &&
    typeof value.reason === "string" &&
    typeof value.attemptGroupId === "string" &&
    Number.isSafeInteger(value.attemptIndex) &&
    (value.attemptIndex as number) >= 0 &&
    provider !== null &&
    typeof provider === "object" &&
    !Array.isArray(provider) &&
    typeof (provider as Record<string, unknown>).instance === "string" &&
    typeof (provider as Record<string, unknown>).model === "string" &&
    ["claude", "codex", "agy"].includes(String((provider as Record<string, unknown>).kind))
  );
}
function isHeader(value: Record<string, unknown> | null): value is Record<string, unknown> & DispatchStreamHeader {
  return (
    value?.schema === streamSchema &&
    value.kind === "dispatch" &&
    typeof value.dispatchId === "string" &&
    (value.taskId === null || typeof value.taskId === "string") &&
    (value.schedule === undefined ||
      (value.schedule !== null &&
        typeof value.schedule === "object" &&
        !Array.isArray(value.schedule) &&
        typeof (value.schedule as Record<string, unknown>).scheduleId === "string" &&
        typeof (value.schedule as Record<string, unknown>).claimFence === "string")) &&
    (value.executionId === null || typeof value.executionId === "string") &&
    typeof value.runtimeSessionId === "string" &&
    typeof value.instanceId === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.eventStreamRef === "string"
  );
}
