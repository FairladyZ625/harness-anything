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

const streamSchema = "runtime-dispatch-stream/v1" as const;
const liveIndexSchema = "runtime-dispatch-live-index/v1" as const;
const forbiddenKey = /(?:token|credential|password|secret|authorization|executablepath|api[-_ ]?key|private[-_ ]?key|cookie)/iu;
const bearer = /\bBearer\s+[^\s,;]+/giu;
const knownToken = /\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}\b/giu;
const sensitiveAssignment = /\b(?:authorization|cookie|credential(?:Ref)?|executablePath|api[-_ ]?key|accessToken|apiToken|password|private[-_ ]?key|secret|token)\s*[:=]\s*[^\s,;}]+/giu;

export interface DispatchStreamHeader {
  readonly schema: typeof streamSchema;
  readonly kind: "dispatch";
  readonly dispatchId: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly eventStreamRef: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly delegatedByAgentId?: string;
  readonly delegatedByAgentName?: string;
  readonly squadId?: string;
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
  readonly appendExitNotification: (value: { readonly phase: "started" | "finished"; readonly started: boolean; readonly exitCode: number | null; readonly timedOut: boolean; readonly errorCode?: string }, occurredAt: string) => void;
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

export function openDispatchStream(rootDir: string, header: Omit<DispatchStreamHeader, "schema" | "kind" | "eventStreamRef">): DispatchStreamWriter {
  const ref = dispatchStreamRef(rootDir, header.dispatchId), target = dispatchStreamPath(rootDir, header.dispatchId);
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
  return { ref, appendProviderEvent: (value, occurredAt) => appendJsonl(target, { schema: streamSchema, kind: "provider_event", occurredAt, event: scrubProviderValue(value) }), appendProviderBinding: (providerSessionId, occurredAt) => appendJsonl(target, { schema: streamSchema, kind: "provider_binding", occurredAt, providerSessionId }), appendExitNotification: (value, occurredAt) => appendJsonl(target, { schema: streamSchema, kind: "exit_notification", occurredAt, ...value }) };
}

export function reopenDispatchStream(rootDir: string, header: DispatchStreamHeader): DispatchStreamWriter {
  const { schema: _schema, kind: _kind, eventStreamRef: _eventStreamRef, ...stored } = header;
  return openDispatchStream(rootDir, stored);
}

export function removeDispatchStream(rootDir: string, dispatchId: string): void {
  const target = dispatchStreamPath(rootDir, dispatchId), header = readDispatchStreamHeader(rootDir, dispatchId);
  if (existsSync(target)) unlinkSync(target);
  if (!header?.taskId) return;
  const { taskId, runtimeSessionId } = header;
  removeDispatchLiveIndexEntries(rootDir, [{ dispatchId, taskId, runtimeSessionId }]);
}

export function readDispatchLiveIndex(rootDir: string, taskIds: readonly string[]): DispatchLiveIndex {
  const entries: DispatchLiveIndexEntry[] = [], missing: string[] = [];
  for (const taskId of new Set(taskIds)) {
    const stored = readStoredDispatchLiveIndex(dispatchLiveIndexPath(rootDir, taskId), taskId);
    if (stored) entries.push(...stored.entries); else missing.push(taskId);
  }
  if (missing.length > 0) entries.push(...rebuildDispatchLiveIndex(rootDir, missing).entries);
  return dispatchLiveIndex(entries);
}

export function rebuildDispatchLiveIndex(rootDir: string, taskIds: readonly string[]): DispatchLiveIndex {
  const root = dispatchStreamRoot(rootDir), selected = new Set(taskIds);
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
  const descriptor = openSync(target, fsConstants.O_RDONLY), chunks: Buffer[] = [];
  try {
    while (true) {
      const chunk = Buffer.alloc(4096), read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const newline = chunk.subarray(0, read).indexOf(10);
      chunks.push(chunk.subarray(0, newline === -1 ? read : newline));
      if (newline !== -1) break;
    }
  } finally { closeSync(descriptor); }
  const first = parseRecord(Buffer.concat(chunks).toString("utf8").replace(/\r$/u, ""));
  return isHeader(first) && first.dispatchId === dispatchId ? first : null;
}

export function readDispatchStream(
  rootDir: string,
  dispatchId: string,
): {
  readonly header: DispatchStreamHeader;
  readonly providerSessionId: string | null;
  readonly process: DispatchProcessState | null;
  readonly records: readonly DispatchStreamRecord[];
} | null {
  const target = dispatchStreamPath(rootDir, dispatchId);
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const lines = readFileSync(target, "utf8").split(/\r?\n/u).filter(Boolean), first = parseRecord(lines[0]);
  if (!isHeader(first) || first.dispatchId !== dispatchId) return null;
  let providerSessionId: string | null = null, processState: DispatchProcessState | null = null;
  const records = lines.slice(1).map(parseRecord).filter((record): record is DispatchStreamRecord => record !== null);
  for (const record of records) {
    if (record.kind === "provider_binding" && typeof record.providerSessionId === "string") {
      providerSessionId = record.providerSessionId;
    }
    if (record.kind === "process_started" && Number.isInteger(record.pid) && Number(record.pid) > 0) {
      processState = { pid: Number(record.pid), exitCode: null, signal: null, exited: false };
    }
    if (record.kind === "process_exit" && processState) {
      processState = {
        ...processState,
        exitCode: Number.isInteger(record.exitCode) ? Number(record.exitCode) : null,
        signal: typeof record.signal === "string" ? record.signal : null,
        exited: true,
      };
    }
  }
  return { header: first, providerSessionId, process: processState, records };
}

export function readDispatchStreams(rootDir: string): readonly NonNullable<ReturnType<typeof readDispatchStream>>[] {
  const root = dispatchStreamRoot(rootDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root)
    .filter((name) => /^dispatch_[a-f0-9]{24}\.jsonl$/u.test(name))
    .map((name) => readDispatchStream(rootDir, name.slice(0, -6)))
    .filter((stream): stream is NonNullable<ReturnType<typeof readDispatchStream>> => stream !== null);
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
  }
  finally { closeSync(descriptor); }
}

export function dispatchStreamRef(rootDir: string, dispatchId: string): string { const relative = path.relative(resolveHarnessLayout(rootDir).rootDir, dispatchStreamPath(rootDir, dispatchId)).split(path.sep).join("/"); return `file:${relative}`; }

export function scrubProviderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubProviderValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenKey.test(key)).map(([key, entry]) => [key, scrubProviderValue(entry)]));
  if (typeof value !== "string") return value;
  return value.replace(bearer, "Bearer [REDACTED]").replace(knownToken, "[REDACTED]").replace(sensitiveAssignment, "[REDACTED]");
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
  const target = dispatchLiveIndexPath(rootDir, taskId), temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
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
      const dispatchId = String(value.dispatchId), runtimeSessionId = value.runtimeSessionId;
      if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) return null;
      if (typeof runtimeSessionId !== "string") return null;
      entries.push({ dispatchId, taskId: value.taskId, runtimeSessionId });
    }
    return dispatchLiveIndex(entries);
  } catch (error) { consumeKnownError(error); return null; }
}
function appendJsonl(target: string, value: unknown): void {
  const descriptor = openSync(target, fsConstants.O_APPEND | fsConstants.O_WRONLY);
  try {
    writeFileSync(descriptor, `${JSON.stringify(scrubProviderValue(value))}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
function parseRecord(value: string | undefined): Record<string, unknown> | null { if (!value) return null; try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch (error) { consumeKnownError(error); return null; } }
function isDispatchIndexRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isHeader(value: Record<string, unknown> | null): value is Record<string, unknown> & DispatchStreamHeader { return value?.schema === streamSchema && value.kind === "dispatch" && typeof value.dispatchId === "string" && (value.taskId === null || typeof value.taskId === "string") && (value.executionId === null || typeof value.executionId === "string") && typeof value.runtimeSessionId === "string" && typeof value.instanceId === "string" && typeof value.startedAt === "string" && typeof value.eventStreamRef === "string"; }
