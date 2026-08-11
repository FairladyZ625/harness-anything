import path from "node:path";
import { Effect } from "effect";
import {
  serializeTaskEvent,
  validateTaskEvent,
  type TaskEventV1
} from "../domain/task-lifecycle.contract.ts";
import { taskEntityId } from "../domain/entity-id.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import type { WriteCoordinator } from "../ports/write-coordinator.ts";
import type { WriteError } from "../domain/errors.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import { appendJsonLineDurably } from "./write-journal-durable.ts";

export type TaskEventStoreErrorCode =
  | "invalid_stream"
  | "legacy_shape"
  | "op_conflict"
  | "revision_conflict";

export class TaskEventStoreError extends Error {
  readonly code: TaskEventStoreErrorCode;
  constructor(code: TaskEventStoreErrorCode, message: string) {
    super(message);
    this.name = "TaskEventStoreError";
    this.code = code;
  }
}

export interface TaskEventStreamV1 {
  readonly schema: "task-event-stream/v1";
  readonly revision: number;
  readonly events: readonly TaskEventV1[];
}

export type TaskEventAppendReceipt =
  | { readonly status: "applied"; readonly event: TaskEventV1; readonly revision: number }
  | { readonly status: "indeterminate"; readonly reason: string; readonly query: "read_task_event_stream" };

export interface TaskEventStore {
  readonly path: string;
  readonly read: () => TaskEventStreamV1;
  readonly append: (event: TaskEventV1) => Effect.Effect<TaskEventAppendReceipt, never>;
}

export function makeTaskEventStore(options: {
  readonly rootInput?: HarnessLayoutInput;
  readonly rootDir?: string;
  readonly coordinator: WriteCoordinator;
}): TaskEventStore {
  const rootInput = options.rootInput ?? options.rootDir;
  if (rootInput === undefined) throw new Error("task event store requires rootInput or rootDir");
  const layout = resolveHarnessLayout(rootInput);
  const streamPath = path.join(layout.authoredRoot, "task-events.ndjson");
  const relativePath = path.relative(layout.rootDir, streamPath).split(path.sep).join("/");
  const read = () => readTaskEventStream(streamPath);
  return {
    path: streamPath,
    read,
    append: (event) => Effect.gen(function* () {
      const canonical = serializeTaskEvent(event);
      const before = read();
      const existing = before.events.find((candidate) => candidate.opId === event.opId);
      if (existing !== undefined) {
        if (serializeTaskEvent(existing) !== canonical) throw new TaskEventStoreError("op_conflict", `opId ${event.opId} already names a different event`);
        return { status: "applied", event: existing, revision: existing.workspaceRevision };
      }
      if (event.workspaceRevision !== before.revision + 1) {
        throw new TaskEventStoreError("revision_conflict", `workspace revision ${event.workspaceRevision} must follow ${before.revision}`);
      }
      const publicationError = yield* options.coordinator.enqueue({
          opId: event.opId,
          entityId: taskEntityId(event.taskId),
          kind: "machine_artifact_append_jsonl",
          payload: {
            boundary: "task-event-stream",
            path: relativePath,
            value: JSON.parse(canonical) as Record<string, unknown>
          }
        }).pipe(
          Effect.flatMap(() => options.coordinator.flush("explicit")),
          Effect.match({ onFailure: (error) => error, onSuccess: () => null })
        );
      if (publicationError !== null) return receiptAfterPublicationError(read, event, canonical, writeErrorMessage(publicationError));
      return receiptAfterPublicationError(read, event, canonical, "event was not observable after publication");
    })
  };
}

export function readTaskEventStream(streamPath: string): TaskEventStreamV1 {
  if (!localLayoutFileSystem.exists(streamPath)) return { schema: "task-event-stream/v1", revision: 0, events: [] };
  const body = localLayoutFileSystem.readText(streamPath);
  if (body.trim().length === 0) return { schema: "task-event-stream/v1", revision: 0, events: [] };
  rejectLegacyDocument(body);
  const events: TaskEventV1[] = [];
  const opIds = new Set<string>();
  for (const [index, line] of body.trimEnd().split("\n").entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TaskEventStoreError("invalid_stream", `task event line ${index + 1} is not canonical NDJSON`);
    }
    const issues = validateTaskEvent(parsed);
    if (issues.length > 0) throw shapeError(parsed, `task event line ${index + 1}: ${issues.map((issue) => issue.message).join("; ")}`);
    const event = parsed as TaskEventV1;
    if (`${line}\n` !== serializeTaskEvent(event)) throw new TaskEventStoreError("invalid_stream", `task event line ${index + 1} is not canonically serialized`);
    if (event.workspaceRevision !== index + 1) throw new TaskEventStoreError("invalid_stream", `task event revision ${event.workspaceRevision} is not contiguous`);
    if (opIds.has(event.opId)) throw new TaskEventStoreError("op_conflict", `duplicate task event opId ${event.opId}`);
    opIds.add(event.opId);
    events.push(event);
  }
  return { schema: "task-event-stream/v1", revision: events.length, events };
}

export function appendTaskEventAtPublicationBoundary(streamPath: string, value: Record<string, unknown>): boolean {
  const issues = validateTaskEvent(value);
  if (issues.length > 0) throw shapeError(value, issues.map((issue) => issue.message).join("; "));
  const event = value as unknown as TaskEventV1;
  const canonical = serializeTaskEvent(event);
  const stream = readTaskEventStream(streamPath);
  const sameOp = stream.events.find((candidate) => candidate.opId === event.opId);
  if (sameOp !== undefined) return serializeTaskEvent(sameOp) === canonical;
  if (event.workspaceRevision !== stream.revision + 1) return false;
  appendJsonLineDurably(streamPath, JSON.parse(canonical) as Record<string, unknown>);
  return true;
}

function receiptAfterPublicationError(
  read: () => TaskEventStreamV1,
  event: TaskEventV1,
  canonical: string,
  reason: string
): TaskEventAppendReceipt {
  try {
    const stream = read();
    const existing = stream.events.find((candidate) => candidate.opId === event.opId);
    if (existing !== undefined) {
      if (serializeTaskEvent(existing) !== canonical) throw new TaskEventStoreError("op_conflict", `opId ${event.opId} already names a different event`);
      return { status: "applied", event: existing, revision: existing.workspaceRevision };
    }
    if (stream.events.some((candidate) => candidate.workspaceRevision === event.workspaceRevision)) {
      throw new TaskEventStoreError("revision_conflict", `workspace revision ${event.workspaceRevision} was accepted by another operation`);
    }
  } catch (error) {
    if (error instanceof TaskEventStoreError) throw error;
    consumeKnownError(error);
  }
  return { status: "indeterminate", reason, query: "read_task_event_stream" };
}

function rejectLegacyDocument(body: string): void {
  try {
    const value = JSON.parse(body) as { readonly schema?: unknown };
    if (value.schema !== "task-event/v1") throw shapeError(value, "legacy task event shape is not readable");
  } catch (error) {
    if (error instanceof TaskEventStoreError) throw error;
    consumeKnownError(error);
  }
}

function shapeError(value: unknown, message: string): TaskEventStoreError {
  const schema = value && typeof value === "object" && "schema" in value ? String(value.schema) : "unknown";
  const legacy = /^(?:execution|review|task-holder)\//u.test(schema);
  return new TaskEventStoreError(legacy ? "legacy_shape" : "invalid_stream", legacy
    ? `${message}; use the archived CLI on archive/main`
    : message);
}

function writeErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "_tag" in error) {
    const writeError = error as WriteError;
    return writeError._tag === "WriteRejected" ? writeError.reason : writeError._tag;
  }
  return error instanceof Error ? error.message : String(error);
}

function consumeKnownError(error: unknown): void { void error; }
