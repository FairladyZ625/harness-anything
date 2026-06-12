import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeLocalLifecycleEngine } from "../../adapters/local/src/index.ts";
import type { DomainStatus } from "../../kernel/src/index.ts";
import { isDomainStatus, readTaskProjection } from "../../kernel/src/index.ts";

export interface LocalControllerServiceOptions {
  readonly rootDir: string;
}

export interface LocalControllerSuccess {
  readonly ok: true;
}

export interface LocalControllerFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly hint: string;
  };
}

export type LocalControllerResult = LocalControllerSuccess | LocalControllerFailure;

export type TaskListResult = (LocalControllerSuccess & {
  readonly tasks: ReadonlyArray<unknown>;
  readonly warnings: ReadonlyArray<unknown>;
}) | LocalControllerFailure;

export type TaskDetailResult = (LocalControllerSuccess & {
  readonly task?: unknown;
  readonly documents?: ReadonlyArray<{ readonly path: string }>;
}) | LocalControllerFailure;

export type TaskDocumentResult = (LocalControllerSuccess & {
  readonly taskId?: string;
  readonly path?: string;
  readonly body?: string;
}) | LocalControllerFailure;

export interface LocalControllerService {
  readonly getTasks: () => TaskListResult;
  readonly getTaskDetail: (payload: unknown) => TaskDetailResult;
  readonly getTaskDocument: (payload: unknown) => TaskDocumentResult;
  readonly setTaskStatus: (payload: unknown) => Promise<LocalControllerResult>;
  readonly reviewTask: (payload: unknown) => Promise<LocalControllerResult>;
  readonly appendTaskProgress: (payload: unknown) => Promise<LocalControllerResult>;
  readonly rebuildGovernance: () => TaskListResult;
  readonly archiveTask: () => LocalControllerResult;
  readonly openShell: () => LocalControllerResult & {
    readonly policy: {
      readonly displayOnly: true;
      readonly outputCreatesTaskState: false;
    };
  };
}

export function makeLocalControllerService(options: LocalControllerServiceOptions): LocalControllerService {
  const rootDir = path.resolve(options.rootDir);
  const engine = makeLocalLifecycleEngine({ rootDir });

  return {
    getTasks: () => {
      const result = readTaskProjection({ rootDir });
      return { ok: true, tasks: result.rows, warnings: result.warnings };
    },
    getTaskDetail: (payload) => {
      const parsed = readTaskIdPayload(payload);
      if (!parsed.ok) return parsed;
      const projection = readTaskProjection({ rootDir });
      const task = projection.rows.find((row) => row.taskId === parsed.taskId);
      if (!task) return taskNotFound(parsed.taskId);
      return {
        ok: true,
        task,
        documents: listKnownTaskDocuments(rootDir, parsed.taskId)
      };
    },
    getTaskDocument: (payload) => {
      const parsed = readTaskDocumentPayload(payload);
      if (!parsed.ok) return parsed;
      const documentPath = taskDocumentPath(rootDir, parsed.taskId, parsed.path);
      if (!existsSync(documentPath)) return { ok: false, error: { code: "document_not_found", hint: parsed.path } };
      return {
        ok: true,
        taskId: parsed.taskId,
        path: parsed.path,
        body: readFileSync(documentPath, "utf8")
      };
    },
    setTaskStatus: async (payload) => {
      const parsed = readSetStatusPayload(payload);
      if (!parsed.ok) return parsed;
      return Effect.runPromise(engine.setStatus({ taskId: parsed.taskId, status: parsed.status }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: { code: error._tag, hint: "Status update failed." } }),
          onSuccess: () => ({ ok: true })
        })
      ));
    },
    reviewTask: async (payload) => {
      const parsed = readTaskIdPayload(payload);
      if (!parsed.ok) return parsed;
      return Effect.runPromise(engine.setStatus({ taskId: parsed.taskId, status: "in_review" }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: { code: error._tag, hint: "Review transition failed." } }),
          onSuccess: () => ({ ok: true })
        })
      ));
    },
    appendTaskProgress: async (payload) => {
      const parsed = readAppendProgressPayload(payload);
      if (!parsed.ok) return parsed;
      return Effect.runPromise(engine.appendProgress({ taskId: parsed.taskId, text: parsed.text }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: { code: error._tag, hint: "Progress append failed." } }),
          onSuccess: () => ({ ok: true })
        })
      ));
    },
    rebuildGovernance: () => {
      const result = readTaskProjection({ rootDir });
      return { ok: true, tasks: result.rows, warnings: result.warnings };
    },
    archiveTask: () => ({
      ok: false,
      error: {
        code: "unsupported_in_kr09",
        hint: "Archive mutation is reserved for the closeout workflow task."
      }
    }),
    openShell: () => ({
      ok: true,
      policy: {
        displayOnly: true,
        outputCreatesTaskState: false
      }
    })
  };
}

function listKnownTaskDocuments(rootDir: string, taskId: string): ReadonlyArray<{ readonly path: string }> {
  return ["INDEX.md", "progress.md", "review.md", "findings.md"]
    .filter((documentPath) => existsSync(taskDocumentPath(rootDir, taskId, documentPath)))
    .map((documentPath) => ({ path: documentPath }));
}

function taskDocumentPath(rootDir: string, taskId: string, documentPath: string): string {
  validateTaskId(taskId);
  validateRelativeDocumentPath(documentPath);
  return path.join(rootDir, "tasks", taskId, documentPath);
}

function readTaskIdPayload(payload: unknown): { readonly ok: true; readonly taskId: string } | LocalControllerFailure {
  if (!isRecord(payload) || typeof payload.taskId !== "string") {
    return invalidPayload("taskId is required.");
  }
  validateTaskId(payload.taskId);
  return { ok: true, taskId: payload.taskId };
}

function readTaskDocumentPayload(payload: unknown): { readonly ok: true; readonly taskId: string; readonly path: string } | LocalControllerFailure {
  const taskPayload = readTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isRecord(payload) || typeof payload.path !== "string") {
    return invalidPayload("path is required.");
  }
  validateRelativeDocumentPath(payload.path);
  return { ok: true, taskId: taskPayload.taskId, path: payload.path };
}

function readSetStatusPayload(payload: unknown): { readonly ok: true; readonly taskId: string; readonly status: DomainStatus } | LocalControllerFailure {
  const taskPayload = readTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isRecord(payload) || typeof payload.status !== "string" || !isDomainStatus(payload.status)) {
    return invalidPayload("valid status is required.");
  }
  return { ok: true, taskId: taskPayload.taskId, status: payload.status };
}

function readAppendProgressPayload(payload: unknown): { readonly ok: true; readonly taskId: string; readonly text: string } | LocalControllerFailure {
  const taskPayload = readTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isRecord(payload) || typeof payload.text !== "string" || payload.text.length === 0) {
    return invalidPayload("text is required.");
  }
  return { ok: true, taskId: taskPayload.taskId, text: payload.text };
}

function validateTaskId(taskId: string): void {
  if (taskId.length === 0 || taskId.includes("/") || taskId.includes("..")) {
    throw new Error(`invalid task id: ${taskId}`);
  }
}

function validateRelativeDocumentPath(documentPath: string): void {
  if (path.isAbsolute(documentPath)) throw new Error("absolute document paths are not allowed");
  const normalized = path.normalize(documentPath);
  if (normalized === "." || normalized.startsWith("..")) throw new Error("document path must stay inside the task package");
}

function invalidPayload(hint: string): LocalControllerFailure {
  return { ok: false, error: { code: "invalid_payload", hint } };
}

function taskNotFound(taskId: string): LocalControllerFailure {
  return { ok: false, error: { code: "task_not_found", hint: `task not found: ${taskId}` } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
