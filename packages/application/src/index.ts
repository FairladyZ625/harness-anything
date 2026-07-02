import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { DomainStatus, EngineError, ProjectionWarning, TaskProjectionRow, WriteError } from "../../kernel/src/index.ts";
import { isDomainStatus, readTaskProjection } from "../../kernel/src/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../kernel/src/layout/index.ts";
import { createHarnessRuntimeContext, normalizeRelativeDocumentPath, taskDocumentPath as harnessTaskDocumentPath, validateTaskIdSyntax } from "../../kernel/src/layout/index.ts";
export { currentSessionToProvenancePayload, defaultRuntimeSessionEnvCandidates, makeEnvironmentCurrentSessionProbe, makeHumanFallbackSessionProbe } from "./current-session-probe.ts";
export { makeDecisionWriteService } from "./decision-write-service.ts";
export { makeFactWriteService } from "./fact-write-service.ts";
export { makeProvenanceSessionExporter } from "./provenance-session-exporter.ts";
export { readDecisionDocument } from "./decision-document-reader.ts";
export type { EnvironmentCurrentSessionProbeOptions, HumanFallbackSessionProbeOptions, RuntimeSessionEnvCandidate } from "./current-session-probe.ts";
export type {
  DecisionDocumentReadResult
} from "./decision-document-reader.ts";
export type {
  DecisionCreateInput,
  DecisionAmendRequest,
  DecisionTransitionRequest,
  DecisionWriteRejected,
  DecisionWriteRequest,
  DecisionWriteResult,
  DecisionWriteService,
  DecisionWriteServiceOptions
} from "./decision-write-service.ts";
export type {
  FactRecordRequest,
  FactWriteRejected,
  FactWriteResult,
  FactWriteService,
  FactWriteServiceOptions
} from "./fact-write-service.ts";
export type {
  ProvenanceSessionDocument,
  ProvenanceSessionExporter,
  ProvenanceSessionExporterOptions,
  ProvenanceSessionExporterRejected,
  ProvenanceSessionExportResult
} from "./provenance-session-exporter.ts";
import { makeTaskLifecycleOrchestrator } from "./task-lifecycle-orchestrator.ts";
export {
  evaluateCompletionGate,
  evaluateReviewGate,
  parseReviewMarkdown,
  validatePhaseRows
} from "./task-lifecycle-gates.ts";
export {
  makeTaskLifecycleOrchestrator,
  readTaskLifecyclePolicy
} from "./task-lifecycle-orchestrator.ts";
export type {
  CompletionGateInput,
  PhaseRow,
  ReviewFinding,
  ReviewGateInput,
  ReviewGateResult,
  VerifierBackedReviewContract
} from "./task-lifecycle-gates.ts";
export type {
  TaskLifecycleError,
  TaskLifecycleFailure,
  TaskLifecycleOrchestrator,
  TaskLifecycleOrchestratorOptions,
  TaskLifecyclePolicy,
  TaskLifecycleProgressWriteResult,
  TaskLifecycleResult,
  TaskLifecycleStatusWriteResult,
  TaskLifecycleSuccess,
  TaskLifecycleWriter
} from "./task-lifecycle-orchestrator.ts";

export interface LocalControllerServiceOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly taskWriter: LocalControllerTaskWriter;
}

export interface LocalControllerSuccess {
  readonly ok: true;
}

export interface LocalControllerError {
  readonly code: string;
  readonly hint: string;
}

export interface LocalControllerFailure {
  readonly ok: false;
  readonly error: LocalControllerError;
}

export type LocalControllerResult = LocalControllerSuccess | LocalControllerFailure;

export interface TaskListSuccess extends LocalControllerSuccess {
  readonly tasks: ReadonlyArray<TaskProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export type TaskListResult = TaskListSuccess | LocalControllerFailure;

export interface TaskDocumentDescriptor {
  readonly path: string;
}

export interface TaskDetailSuccess extends LocalControllerSuccess {
  readonly task?: TaskProjectionRow;
  readonly documents?: ReadonlyArray<TaskDocumentDescriptor>;
}

export type TaskDetailResult = TaskDetailSuccess | LocalControllerFailure;

export interface TaskDocumentSuccess extends LocalControllerSuccess {
  readonly taskId?: string;
  readonly path?: string;
  readonly body?: string;
}

export type TaskDocumentResult = TaskDocumentSuccess | LocalControllerFailure;

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

export interface LocalControllerStatusWriteResult {
  readonly taskId: string;
  readonly status: DomainStatus;
}

export interface LocalControllerProgressWriteResult {
  readonly taskId: string;
  readonly path: string;
}

export interface LocalControllerTaskWriter {
  readonly setStatus: (payload: SetTaskStatusPayload) => Effect.Effect<LocalControllerStatusWriteResult, EngineError | WriteError>;
  readonly appendProgress: (payload: AppendTaskProgressPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteError>;
}

export interface ShellPanelPolicy {
  readonly displayOnly: true;
  readonly outputCreatesTaskState: false;
}

export interface OpenShellSuccess extends LocalControllerSuccess {
  readonly policy: ShellPanelPolicy;
}

export type OpenShellResult = OpenShellSuccess | LocalControllerFailure;

export interface LocalControllerService {
  readonly getTasks: () => TaskListResult;
  readonly getTaskDetail: (payload: TaskIdPayload) => TaskDetailResult;
  readonly getTaskDocument: (payload: TaskDocumentPayload) => TaskDocumentResult;
  readonly setTaskStatus: (payload: SetTaskStatusPayload) => Promise<LocalControllerResult>;
  readonly reviewTask: (payload: TaskIdPayload) => Promise<LocalControllerResult>;
  readonly appendTaskProgress: (payload: AppendTaskProgressPayload) => Promise<LocalControllerResult>;
  readonly rebuildGovernance: () => TaskListResult;
  readonly archiveTask: () => LocalControllerResult;
  readonly openShell: () => OpenShellResult;
}

export function makeLocalControllerService(options: LocalControllerServiceOptions): LocalControllerService {
  const rootDir = path.resolve(options.rootDir);
  const layoutInput = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const taskWriter = options.taskWriter;
  const lifecycleOrchestrator = makeTaskLifecycleOrchestrator({
    rootDir,
    layoutOverrides: options.layoutOverrides,
    taskWriter
  });

  return {
    getTasks: () => {
      const result = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides });
      return { ok: true, tasks: result.rows, warnings: result.warnings };
    },
    getTaskDetail: (payload) => {
      validateTaskId(payload.taskId);
      const projection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides });
      const task = projection.rows.find((row) => row.taskId === payload.taskId);
      if (!task) return taskNotFound(payload.taskId);
      return {
        ok: true,
        task,
        documents: listKnownTaskDocuments(layoutInput, payload.taskId)
      };
    },
    getTaskDocument: (payload) => {
      validateTaskId(payload.taskId);
      const parsed = readTaskDocumentPayload(payload);
      if (!parsed.ok) return parsed;
      const documentPath = taskDocumentPath(layoutInput, parsed.taskId, parsed.path);
      if (!existsSync(documentPath)) return { ok: false, error: { code: "document_not_found", hint: parsed.path } };
      return {
        ok: true,
        taskId: parsed.taskId,
        path: parsed.path,
        body: readFileSync(documentPath, "utf8")
      };
    },
    setTaskStatus: async (payload) => {
      validateTaskId(payload.taskId);
      return Effect.runPromise(lifecycleOrchestrator.setTaskStatus(payload).pipe(Effect.map(toLocalControllerResult)));
    },
    reviewTask: async (payload) => {
      validateTaskId(payload.taskId);
      return Effect.runPromise(lifecycleOrchestrator.startTaskReview(payload).pipe(Effect.map(toLocalControllerResult)));
    },
    appendTaskProgress: async (payload) => {
      validateTaskId(payload.taskId);
      return Effect.runPromise(taskWriter.appendProgress({ taskId: payload.taskId, text: payload.text }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: { code: error._tag, hint: "Progress append failed." } }),
          onSuccess: () => ({ ok: true })
        })
      ));
    },
    rebuildGovernance: () => {
      const result = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides });
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

function listKnownTaskDocuments(rootInput: HarnessLayoutInput, taskId: string): ReadonlyArray<{ readonly path: string }> {
  return ["INDEX.md", "progress.md", "review.md", "findings.md"]
    .filter((documentPath) => existsSync(taskDocumentPath(rootInput, taskId, documentPath)))
    .map((documentPath) => ({ path: documentPath }));
}

function taskDocumentPath(rootInput: HarnessLayoutInput, taskId: string, documentPath: string): string {
  validateTaskId(taskId);
  return harnessTaskDocumentPath(rootInput, taskId, documentPath);
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
    return { ok: true, taskId: taskPayload.taskId, path: normalizeRelativeDocumentPath(payload.path) };
  } catch {
    return invalidPayload("portable document path is required.");
  }
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

function invalidPayload(hint: string): LocalControllerFailure {
  return { ok: false, error: { code: "invalid_payload", hint } };
}

function taskNotFound(taskId: string): LocalControllerFailure {
  return { ok: false, error: { code: "task_not_found", hint: `task not found: ${taskId}` } };
}

function toLocalControllerResult(result: { readonly ok: true } | { readonly ok: false; readonly error: LocalControllerError }): LocalControllerResult {
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
