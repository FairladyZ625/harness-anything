import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeLocalLifecycleEngine } from "../../adapters/local/src/index.ts";
import type { DomainStatus } from "../../kernel/src/index.ts";
import { isDomainStatus, isTerminalStatus, readTaskProjection } from "../../kernel/src/index.ts";
import { taskDocumentPath as harnessTaskDocumentPath, validateTaskIdSyntax } from "../../kernel/src/layout/index.ts";
export {
  evaluateCompletionGate,
  evaluateReviewGate,
  parseReviewMarkdown,
  validatePhaseRows
} from "./task-lifecycle-gates.ts";
export type {
  CompletionGateInput,
  PhaseRow,
  ReviewFinding,
  ReviewGateInput,
  ReviewGateResult,
  VerifierBackedReviewContract
} from "./task-lifecycle-gates.ts";

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

export interface TaskIdPayload {
  readonly taskId: string;
}

export interface TaskDocumentPayload extends TaskIdPayload {
  readonly path: string;
}

export interface SetTaskStatusPayload extends TaskIdPayload {
  readonly status: DomainStatus;
}

export interface AppendTaskProgressPayload extends TaskIdPayload {
  readonly text: string;
}

export interface LocalControllerService {
  readonly getTasks: () => TaskListResult;
  readonly getTaskDetail: (payload: TaskIdPayload) => TaskDetailResult;
  readonly getTaskDocument: (payload: TaskDocumentPayload) => TaskDocumentResult;
  readonly setTaskStatus: (payload: SetTaskStatusPayload) => Promise<LocalControllerResult>;
  readonly reviewTask: (payload: TaskIdPayload) => Promise<LocalControllerResult>;
  readonly appendTaskProgress: (payload: AppendTaskProgressPayload) => Promise<LocalControllerResult>;
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
      validateTaskId(payload.taskId);
      const projection = readTaskProjection({ rootDir });
      const task = projection.rows.find((row) => row.taskId === payload.taskId);
      if (!task) return taskNotFound(payload.taskId);
      return {
        ok: true,
        task,
        documents: listKnownTaskDocuments(rootDir, payload.taskId)
      };
    },
    getTaskDocument: (payload) => {
      validateTaskId(payload.taskId);
      validateRelativeDocumentPath(payload.path);
      const documentPath = taskDocumentPath(rootDir, payload.taskId, payload.path);
      if (!existsSync(documentPath)) return { ok: false, error: { code: "document_not_found", hint: payload.path } };
      return {
        ok: true,
        taskId: payload.taskId,
        path: payload.path,
        body: readFileSync(documentPath, "utf8")
      };
    },
    setTaskStatus: async (payload) => {
      validateTaskId(payload.taskId);
      if (isTerminalStatus(payload.status)) {
        return {
          ok: false,
          error: {
            code: "terminal_status_requires_task_complete",
            hint: payload.status === "done"
              ? "Use task-complete after review, CI, and closeout gates pass."
              : "Terminal cancellation requires an audited recovery path."
          }
        };
      }
      return Effect.runPromise(engine.setStatus({ taskId: payload.taskId, status: payload.status }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: { code: error._tag, hint: "Status update failed." } }),
          onSuccess: () => ({ ok: true })
        })
      ));
    },
    reviewTask: async (payload) => {
      validateTaskId(payload.taskId);
      return Effect.runPromise(engine.setStatus({ taskId: payload.taskId, status: "in_review" }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: { code: error._tag, hint: "Review transition failed." } }),
          onSuccess: () => ({ ok: true })
        })
      ));
    },
    appendTaskProgress: async (payload) => {
      validateTaskId(payload.taskId);
      return Effect.runPromise(engine.appendProgress({ taskId: payload.taskId, text: payload.text }).pipe(
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
  return harnessTaskDocumentPath(rootDir, taskId, documentPath);
}

export function readTaskIdPayload(payload: unknown): { readonly ok: true; readonly taskId: string } | LocalControllerFailure {
  if (!isRecord(payload) || typeof payload.taskId !== "string") {
    return invalidPayload("taskId is required.");
  }
  try {
    validateTaskId(payload.taskId);
  } catch {
    return invalidPayload("taskId is invalid.");
  }
  return { ok: true, taskId: payload.taskId };
}

export function readTaskDocumentPayload(payload: unknown): { readonly ok: true; readonly taskId: string; readonly path: string } | LocalControllerFailure {
  const taskPayload = readTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isRecord(payload) || typeof payload.path !== "string") {
    return invalidPayload("path is required.");
  }
  try {
    validateRelativeDocumentPath(payload.path);
  } catch {
    return invalidPayload("path must stay inside the task package.");
  }
  return { ok: true, taskId: taskPayload.taskId, path: payload.path };
}

export function readSetStatusPayload(payload: unknown): { readonly ok: true; readonly taskId: string; readonly status: DomainStatus } | LocalControllerFailure {
  const taskPayload = readTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isRecord(payload) || typeof payload.status !== "string" || !isDomainStatus(payload.status)) {
    return invalidPayload("valid status is required.");
  }
  return { ok: true, taskId: taskPayload.taskId, status: payload.status };
}

export function readAppendProgressPayload(payload: unknown): { readonly ok: true; readonly taskId: string; readonly text: string } | LocalControllerFailure {
  const taskPayload = readTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isRecord(payload) || typeof payload.text !== "string" || payload.text.length === 0) {
    return invalidPayload("text is required.");
  }
  return { ok: true, taskId: taskPayload.taskId, text: payload.text };
}

function validateTaskId(taskId: string): void {
  validateTaskIdSyntax(taskId);
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
