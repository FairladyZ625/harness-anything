import path from "node:path";
import { serializeTaskEvent, validateTaskEvent, type TaskEventV1 } from "../domain/task-lifecycle.contract.ts";
import { serializeEventHead, type EventHead } from "../domain/write-chain.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localEventFileSystem } from "../local/local-layout-file-system.ts";
import { finalizeLocalEventCommit, localGitProcessCount, localGitText, normalizeLocalPath, prepareLocalEventCommit } from "./local-version-control-system.ts";

export type TaskEventStoreErrorCode = "invalid_store" | "legacy_shape" | "op_conflict" | "revision_conflict" | "publication_indeterminate";

export class TaskEventStoreError extends Error {
  readonly code: TaskEventStoreErrorCode;
  constructor(code: TaskEventStoreErrorCode, message: string) { super(message); this.name = "TaskEventStoreError"; this.code = code; }
}

export interface TaskEventStreamV1 {
  readonly schema: "task-event-stream/v1"; readonly revision: number; readonly events: readonly TaskEventV1[];
}

export interface PublicationMetrics {
  readonly gitProcesses: number; readonly nodeSyncs: number; readonly changedPaths: readonly string[];
}

export type TaskEventAppendReceipt = {
  readonly status: "applied"; readonly event: TaskEventV1; readonly revision: number; readonly commitSha: string; readonly metrics: PublicationMetrics;
};

export interface EventRecoveryReceipt {
  readonly status: "none" | "cleared" | "committed" | "already_committed" | "indeterminate"; readonly publications: 0 | 1; readonly elapsedMs: number;
}

export interface EventFileBatch {
  readonly sourceRevision: number; readonly events: readonly TaskEventV1[]; readonly cursor: string | null; readonly done: boolean; readonly accessedItems: number;
}

export type EventPublicationKillpoint = "before_event_write" | "after_event_write" | "after_head_write" | "after_git_commit"
  | "after_sqlite_commit" | "before_response_write" | "after_response_write";

interface PendingPublication {
  readonly schema: "event-publication-pending/v1"; readonly event: TaskEventV1; readonly head: EventHead;
  readonly previousHead: EventHead | null; readonly previousCommitSha: string;
}

export interface TaskEventStore {
  readonly path: string; readonly headPath: string; readonly read: () => TaskEventStreamV1; readonly readHead: () => EventHead | null;
  readonly readEvent: (opId: string) => TaskEventV1 | null; readonly readBatch: (cursor: string | null, maxItems: number) => EventFileBatch;
  readonly append: (event: TaskEventV1) => TaskEventAppendReceipt; readonly recover: () => EventRecoveryReceipt; readonly rebuildHead: () => EventHead | null;
}

export function makeTaskEventStore(options: { readonly rootInput?: HarnessLayoutInput; readonly rootDir?: string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void }): TaskEventStore {
  const rootInput = options.rootInput ?? options.rootDir;
  if (rootInput === undefined) throw new Error("task event store requires rootInput or rootDir");
  const layout = resolveHarnessLayout(rootInput);
  const eventsRoot = path.join(layout.authoredRoot, "events");
  const headPath = path.join(eventsRoot, "head.json");
  const pendingPath = path.join(layout.localRoot, "event-publication.json");
  const repoRoot = localEventFileSystem.realpath(localGitText(localEventFileSystem.exists(layout.authoredRoot) ? layout.authoredRoot : layout.rootDir, "rev-parse", "--show-toplevel").trim());
  const branchRef = localGitText(repoRoot, "symbolic-ref", "HEAD").trim();
  const commonDirValue = localGitText(repoRoot, "rev-parse", "--git-common-dir").trim();
  const commonDir = path.resolve(repoRoot, commonDirValue);
  let parentSha = localGitText(repoRoot, "rev-parse", "HEAD").trim();

  const readHead = () => readEventHead(headPath);
  const readEvent = (opId: string) => {
    const candidate = readEventFile(eventPath(eventsRoot, opId));
    const head = readHead();
    return candidate !== null && head !== null && candidate.workspaceRevision <= head.revision ? candidate : null;
  };
  const read = () => readTaskEventFiles(eventsRoot, readHead());
  const rebuildHead = () => { relative(repoRoot, headPath);
    const head = deriveEventHead(readTaskEventFiles(eventsRoot, undefined).events);
    if (head !== null) localEventFileSystem.writeDurably(headPath, serializeEventHead(head));
    return head;
  };
  return {
    path: eventsRoot,
    headPath,
    read,
    readHead,
    readEvent,
    readBatch: (cursor, maxItems) => readEventFileBatch(eventsRoot, readHead(), cursor, maxItems),
    append: (event) => {
      const gitStarted = localGitProcessCount(), eventBytes = serializeTaskEvent(event);
      const targetPath = eventPath(eventsRoot, event.opId);
      const relativeEvent = relative(repoRoot, targetPath), relativeHead = relative(repoRoot, headPath); relative(layout.rootDir, pendingPath);
      const existing = readEventFile(targetPath);
      if (existing !== null) {
        if (serializeTaskEvent(existing) !== eventBytes) throw new TaskEventStoreError("op_conflict", `opId ${event.opId} already names a different event`);
        if (readHead() === null) rebuildHead();
        return existingReceipt(repoRoot, event, gitStarted);
      }
      const previousHead = readHead();
      if (event.workspaceRevision !== (previousHead?.revision ?? 0) + 1) {
        throw new TaskEventStoreError("revision_conflict", `workspace revision ${event.workspaceRevision} must follow ${previousHead?.revision ?? 0}`);
      }
      const head = { revision: event.workspaceRevision, opId: event.opId,
        eventDigest: `sha256:${sha256Text(eventBytes)}` as const } satisfies EventHead;
      const syncs = { count: 0 };
      syncs.count += localEventFileSystem.writeDurably(pendingPath, `${JSON.stringify({ schema: "event-publication-pending/v1", event, head, previousHead, previousCommitSha: parentSha } satisfies PendingPublication)}\n`);
      options.killpoint?.("before_event_write");
      syncs.count += localEventFileSystem.writeDurably(targetPath, eventBytes);
      options.killpoint?.("after_event_write");
      const changedPaths = [relativeEvent, relativeHead].sort();
      const preparedRef = publicationRef(event.opId);
      const headBytes = serializeEventHead(head), preparedSha = prepareLocalEventCommit(repoRoot, preparedRef, parentSha, changedPaths.map((target) => ({ target, body: target === relativeEvent ? eventBytes : headBytes })), event.opId);
      syncs.count += localEventFileSystem.writeDurably(headPath, headBytes);
      options.killpoint?.("after_head_write");
      finalizeLocalEventCommit(repoRoot, branchRef, parentSha, preparedSha, changedPaths);
      parentSha = preparedSha;
      options.killpoint?.("after_git_commit");
      localEventFileSystem.remove(pendingPath);
      localEventFileSystem.remove(looseRefPath(commonDir, preparedRef));
      return { status: "applied", event, revision: event.workspaceRevision, commitSha: preparedSha,
        metrics: { gitProcesses: localGitProcessCount() - gitStarted, nodeSyncs: syncs.count, changedPaths } };
    },
    recover: () => {
      const started = performance.now(); relative(layout.rootDir, pendingPath); relative(repoRoot, headPath);
      const pending = readPending(pendingPath);
      if (pending === null) return { status: "none", publications: 0, elapsedMs: performance.now() - started };
      const eventFile = eventPath(eventsRoot, pending.event.opId); relative(repoRoot, eventFile);
      const preparedPath = looseRefPath(commonDir, publicationRef(pending.event.opId));
      if (!localEventFileSystem.exists(eventFile) && sameHead(readHead(), pending.previousHead)) {
        localEventFileSystem.remove(pendingPath); localEventFileSystem.remove(preparedPath);
        return { status: "cleared", publications: 0, elapsedMs: performance.now() - started };
      }
      let onDiskEvent: TaskEventV1 | null;
      try { onDiskEvent = readEventFile(eventFile); }
      catch {
        return { status: "indeterminate", publications: 0, elapsedMs: performance.now() - started };
      }
      if (onDiskEvent !== null && serializeTaskEvent(onDiskEvent) === serializeTaskEvent(pending.event)
        && sameHead(readHead(), pending.previousHead)) {
        localEventFileSystem.remove(eventFile); localEventFileSystem.remove(pendingPath); localEventFileSystem.remove(preparedPath);
        return { status: "cleared", publications: 0, elapsedMs: performance.now() - started };
      }
      if (onDiskEvent !== null && serializeTaskEvent(onDiskEvent) === serializeTaskEvent(pending.event)
        && sameHead(readHead(), pending.head)) {
        const changedPaths = [relative(repoRoot, eventFile), relative(repoRoot, headPath)].sort();
        const preparedRef = publicationRef(pending.event.opId);
        let preparedSha = readLooseRef(preparedPath);
        if (parentSha !== pending.previousCommitSha) {
          if (preparedSha !== null && parentSha === preparedSha) {
            localEventFileSystem.remove(pendingPath);
            localEventFileSystem.remove(preparedPath);
            return { status: "already_committed", publications: 0, elapsedMs: performance.now() - started };
          }
          return { status: "indeterminate", publications: 0, elapsedMs: performance.now() - started };
        }
        preparedSha ??= prepareLocalEventCommit(repoRoot, preparedRef, parentSha, changedPaths.map((target) => ({ target, body: localEventFileSystem.readText(path.join(repoRoot, target)) })), pending.event.opId);
        finalizeLocalEventCommit(repoRoot, branchRef, parentSha, preparedSha, changedPaths);
        parentSha = preparedSha;
        localEventFileSystem.remove(pendingPath);
        localEventFileSystem.remove(preparedPath);
        return { status: "committed", publications: 1, elapsedMs: performance.now() - started };
      }
      return { status: "indeterminate", publications: 0, elapsedMs: performance.now() - started };
    },
    rebuildHead
  };
}

function existingReceipt(repoRoot: string, event: TaskEventV1, gitStarted: number): TaskEventAppendReceipt {
  return { status: "applied", event, revision: event.workspaceRevision, commitSha: localGitText(repoRoot, "rev-parse", "HEAD").trim(),
    metrics: { gitProcesses: localGitProcessCount() - gitStarted, nodeSyncs: 0, changedPaths: [] } };
}

function readPending(pendingPath: string): PendingPublication | null {
  if (!localEventFileSystem.exists(pendingPath)) return null;
  const value = JSON.parse(localEventFileSystem.readText(pendingPath)) as PendingPublication;
  if (value.schema !== "event-publication-pending/v1" || !/^[0-9a-f]{40}$/u.test(value.previousCommitSha)) throw new TaskEventStoreError("publication_indeterminate", "pending publication descriptor is invalid");
  return value;
}

function sameHead(left: EventHead | null, right: EventHead | null): boolean { return left === null || right === null ? left === right : serializeEventHead(left) === serializeEventHead(right); }

function publicationRef(opId: string): string { return `refs/ha-event-prepared/${sha256Text(opId)}`; }

function looseRefPath(commonDir: string, ref: string): string { return path.join(commonDir, ...ref.split("/")); }

function readLooseRef(refPath: string): string | null { if (!localEventFileSystem.exists(refPath)) return null;
  const sha = localEventFileSystem.readText(refPath).trim(); return /^[0-9a-f]{40}$/u.test(sha) ? sha : null; }

function readTaskEventFiles(eventsRoot: string, committedHead?: EventHead | null): TaskEventStreamV1 {
  if (!localEventFileSystem.exists(eventsRoot)) return { schema: "task-event-stream/v1", revision: 0, events: [] };
  const allEvents = localEventFileSystem.readNames(eventsRoot)
    .filter((name) => name.endsWith(".json") && name !== "head.json")
    .map((name) => readEventFile(path.join(eventsRoot, name)))
    .filter((event): event is TaskEventV1 => event !== null)
    .sort((left, right) => left.workspaceRevision - right.workspaceRevision);
  const events = committedHead === undefined ? allEvents : committedHead === null ? []
    : allEvents.filter((event) => event.workspaceRevision <= committedHead.revision);
  const opIds = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.workspaceRevision !== index + 1) throw new TaskEventStoreError("invalid_store", `event revision ${event.workspaceRevision} is not contiguous`);
    if (opIds.has(event.opId)) throw new TaskEventStoreError("op_conflict", `duplicate task event opId ${event.opId}`);
    opIds.add(event.opId);
  }
  if (committedHead !== undefined && committedHead !== null) {
    const derived = deriveEventHead(events);
    if (!sameHead(derived, committedHead)) throw new TaskEventStoreError("invalid_store", "event head does not match committed event files");
  }
  return { schema: "task-event-stream/v1", revision: events.length, events };
}

function readEventFileBatch(eventsRoot: string, head: EventHead | null, cursor: string | null, maxItems: number): EventFileBatch {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 64) throw new TaskEventStoreError("invalid_store", "event batch maxItems must be between 1 and 64");
  if (!localEventFileSystem.exists(eventsRoot)) return { sourceRevision: head?.revision ?? 0, events: [], cursor: null, done: true, accessedItems: 0 };
  const names = localEventFileSystem.readNames(eventsRoot).filter((name) => name.endsWith(".json") && name !== "head.json").sort();
  const start = cursor === null ? 0 : firstNameAfter(names, cursor);
  const selected = names.slice(start, start + maxItems);
  const sourceRevision = head?.revision ?? 0;
  const events = selected.map((name) => readEventFile(path.join(eventsRoot, name)))
    .filter((event): event is TaskEventV1 => event !== null && event.workspaceRevision <= sourceRevision);
  return { sourceRevision, events, cursor: selected.at(-1) ?? cursor, done: start + selected.length >= names.length, accessedItems: selected.length };
}

function firstNameAfter(names: readonly string[], cursor: string): number { let low = 0, high = names.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (names[middle]! <= cursor) low = middle + 1; else high = middle; }
  return low; }

function readEventFile(filePath: string): TaskEventV1 | null {
  if (!localEventFileSystem.exists(filePath)) return null;
  let value: unknown;
  const body = localEventFileSystem.readText(filePath);
  try { value = JSON.parse(body); }
  catch { throw new TaskEventStoreError("invalid_store", `${filePath} is not JSON`); }
  const issues = validateTaskEvent(value);
  if (issues.length > 0) throw shapeError(value, issues.map((issue) => issue.message).join("; "));
  const event = value as TaskEventV1;
  if (serializeTaskEvent(event) !== body) throw new TaskEventStoreError("invalid_store", `${filePath} is not canonically serialized`);
  if (path.basename(filePath) !== `${event.opId}.json`) throw new TaskEventStoreError("invalid_store", `${filePath} does not match event opId`);
  return event;
}

function readEventHead(headPath: string): EventHead | null {
  if (!localEventFileSystem.exists(headPath)) return null;
  const body = localEventFileSystem.readText(headPath);
  let head: EventHead;
  try { head = JSON.parse(body) as EventHead; }
  catch { throw new TaskEventStoreError("invalid_store", "event head is not JSON"); }
  if (serializeEventHead(head) !== body) throw new TaskEventStoreError("invalid_store", "event head is not canonically serialized");
  return head;
}

function deriveEventHead(events: readonly TaskEventV1[]): EventHead | null { const event = events.at(-1); if (event === undefined) return null;
  return { revision: event.workspaceRevision, opId: event.opId, eventDigest: `sha256:${sha256Text(serializeTaskEvent(event))}` }; }

function eventPath(eventsRoot: string, opId: string): string {
  if (opId === "head" || opId.length === 0 || /[\\/]/u.test(opId) || opId === "." || opId === "..") throw new TaskEventStoreError("invalid_store", "event opId is not a safe filename");
  return path.join(eventsRoot, `${opId}.json`);
}

function relative(repoRoot: string, filePath: string): string {
  const value = path.relative(normalizeLocalPath(repoRoot), normalizeLocalPath(filePath)).split(path.sep).join("/");
  if (value.startsWith("../") || path.isAbsolute(value)) throw new TaskEventStoreError("invalid_store", "event target is outside the Git repository");
  return value;
}

function shapeError(value: unknown, message: string): TaskEventStoreError { const schema = value && typeof value === "object" && "schema" in value ? String(value.schema) : "unknown";
  const legacy = /^(?:execution|review|task-holder)\//u.test(schema); return new TaskEventStoreError(legacy ? "legacy_shape" : "invalid_store", legacy ? `${message}; use the archived CLI on archive/main` : message); }
