import { commandReceiptEnvelope } from "../../../application/src/index.ts";
import type { CommandReceiptEnvelope } from "../../../application/src/index.ts";
import type { TaskProjectionRow } from "../../../kernel/src/index.ts";

/** @slice-activation Slice 7.5 GUI - Workspace renderer data flow will consume this view projection when wired. */
export type GuiViewId = "board" | "list" | "detail" | "doc-viewer" | "review-queue" | "graph";
export type GuiCoordinationStatus = "open" | "blocked" | "in_review" | "terminal" | "unknown";

export interface GuiTaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly coordinationStatus: GuiCoordinationStatus;
  readonly closeoutReadiness: string;
  readonly parentTaskId?: string;
}

export interface GuiBoardColumn {
  readonly id: GuiCoordinationStatus;
  readonly taskIds: readonly string[];
}

export interface GuiViewModel {
  readonly views: readonly GuiViewId[];
  readonly board: readonly GuiBoardColumn[];
  readonly list: readonly GuiTaskRow[];
  readonly reviewQueue: readonly GuiTaskRow[];
  readonly graph: {
    readonly nodes: readonly { readonly id: string; readonly title: string }[];
    readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: "child" | "related" }[];
  };
}

export interface GuiTaskRouteFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly hint: string;
  };
}

export interface GuiTaskListRead {
  readonly ok: true;
  readonly rows: readonly GuiTaskRow[];
  readonly warnings: readonly unknown[];
}

export type GuiTaskListReadResult = GuiTaskListRead | GuiTaskRouteFailure;

export interface GuiTaskDetailRead {
  readonly ok: true;
  readonly task?: GuiTaskRow;
  readonly documents: readonly { readonly path: string }[];
}

export type GuiTaskDetailReadResult = GuiTaskDetailRead | GuiTaskRouteFailure;

export interface GuiTaskDocumentRead {
  readonly ok: true;
  readonly taskId?: string;
  readonly path?: string;
  readonly body: string;
}

export type GuiTaskDocumentReadResult = GuiTaskDocumentRead | GuiTaskRouteFailure;

export interface GuiCommandFeedback {
  readonly ok: boolean;
  readonly summary: string;
  readonly errorCode?: string;
  readonly hint?: string;
  readonly warnings: readonly unknown[];
}

export const guiTaskProjectionFields = [
  "schema",
  "taskId",
  "title",
  "parentTaskId",
  "coordinationStatus",
  "closeoutReadiness"
] as const satisfies ReadonlyArray<keyof TaskProjectionRow>;

const viewOrder: readonly GuiViewId[] = ["board", "list", "detail", "doc-viewer", "review-queue", "graph"];
const boardOrder: readonly GuiCoordinationStatus[] = ["open", "blocked", "in_review", "terminal", "unknown"];
const coordinationStatuses = new Set<GuiCoordinationStatus>(boardOrder);

export function buildGuiViewModel(rows: readonly GuiTaskRow[]): GuiViewModel {
  const sortedRows = [...rows].sort((left, right) => left.taskId.localeCompare(right.taskId));
  const taskIds = new Set(sortedRows.map((row) => row.taskId));
  return {
    views: viewOrder,
    board: boardOrder.map((status) => ({
      id: status,
      taskIds: sortedRows.filter((row) => row.coordinationStatus === status).map((row) => row.taskId)
    })),
    list: sortedRows,
    reviewQueue: sortedRows.filter((row) => row.closeoutReadiness === "ready"),
    graph: {
      nodes: sortedRows.map((row) => ({ id: row.taskId, title: row.title })),
      edges: sortedRows.flatMap((row) => row.parentTaskId && taskIds.has(row.parentTaskId)
        ? [{ from: row.parentTaskId, to: row.taskId, kind: "child" as const }]
        : [])
    }
  };
}

export function buildGuiViewModelFromTaskProjection(rows: readonly TaskProjectionRow[]): GuiViewModel {
  return buildGuiViewModel(rows.map(toGuiTaskRow));
}

export function readGuiTaskListResult(result: unknown): GuiTaskListReadResult {
  const failure = readGuiTaskRouteFailure(result);
  if (failure) return failure;
  if (!isGuiRecord(result) || result.ok !== true || !Array.isArray(result.tasks)) {
    return invalidTaskRouteResult("invalid_task_list_result", "Task list result must include a tasks array.");
  }
  const rows: GuiTaskRow[] = [];
  for (const task of result.tasks) {
    const row = readGuiTaskRow(task);
    if (!row.ok) return row;
    rows.push(row.row);
  }
  return {
    ok: true,
    rows,
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

export function readGuiTaskDetailResult(result: unknown): GuiTaskDetailReadResult {
  const failure = readGuiTaskRouteFailure(result);
  if (failure) return failure;
  if (!isGuiRecord(result) || result.ok !== true) {
    return invalidTaskRouteResult("invalid_task_detail_result", "Task detail result must be an ok object.");
  }
  const task = result.task === undefined ? undefined : readGuiTaskRow(result.task);
  if (task && !task.ok) return task;
  return {
    ok: true,
    task: task?.row,
    documents: Array.isArray(result.documents)
      ? result.documents.filter(isDocumentDescriptor)
      : []
  };
}

export function readGuiTaskDocumentResult(result: unknown): GuiTaskDocumentReadResult {
  const failure = readGuiTaskRouteFailure(result);
  if (failure) return failure;
  if (!isGuiRecord(result) || result.ok !== true) {
    return invalidTaskRouteResult("invalid_task_document_result", "Task document result must be an ok object.");
  }
  return {
    ok: true,
    taskId: typeof result.taskId === "string" ? result.taskId : undefined,
    path: typeof result.path === "string" ? result.path : undefined,
    body: typeof result.body === "string" ? result.body : ""
  };
}

export function toGuiCommandFeedback(result: unknown): GuiCommandFeedback {
  if (isCommandReceiptEnvelope(result)) {
    return {
      ok: result.ok,
      summary: typeof result.summary === "string" && result.summary.length > 0
        ? result.summary
        : fallbackCommandSummary(result.ok),
      errorCode: result.ok ? undefined : result.error?.code,
      hint: result.ok ? undefined : result.error?.hint,
      warnings: Array.isArray(result.warnings) ? result.warnings : []
    };
  }
  if (!isGuiRecord(result) || typeof result.ok !== "boolean") {
    return {
      ok: false,
      summary: "Command response was not recognized.",
      errorCode: "invalid_command_result",
      hint: "The GUI received a response outside the task command contract.",
      warnings: []
    };
  }
  if (result.ok) {
    return {
      ok: true,
      summary: "Command completed.",
      warnings: Array.isArray(result.warnings) ? result.warnings : []
    };
  }
  const error = isGuiRecord(result.error) ? result.error : {};
  return {
    ok: false,
    summary: "Command failed.",
    errorCode: typeof error.code === "string" ? error.code : "command_failed",
    hint: typeof error.hint === "string" ? error.hint : "The command did not provide a failure hint.",
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

function readGuiTaskRow(value: unknown): { readonly ok: true; readonly row: GuiTaskRow } | GuiTaskRouteFailure {
  if (!isSqliteTaskProjectionRow(value)) {
    return invalidTaskRouteResult("invalid_task_projection_row", "Expected sqlite-task-row/v1 task projection row.");
  }
  return { ok: true, row: toGuiTaskRow(value) };
}

function toGuiTaskRow(row: Pick<TaskProjectionRow, (typeof guiTaskProjectionFields)[number]>): GuiTaskRow {
  return {
    taskId: row.taskId,
    title: row.title,
    coordinationStatus: coordinationStatuses.has(row.coordinationStatus) ? row.coordinationStatus : "unknown",
    closeoutReadiness: row.closeoutReadiness,
    parentTaskId: typeof row.parentTaskId === "string" && row.parentTaskId.length > 0 ? row.parentTaskId : undefined
  };
}

function readGuiTaskRouteFailure(value: unknown): GuiTaskRouteFailure | undefined {
  if (!isGuiRecord(value) || value.ok !== false) return undefined;
  const error = isGuiRecord(value.error) ? value.error : {};
  return {
    ok: false,
    error: {
      code: typeof error.code === "string" ? error.code : "task_route_failed",
      hint: typeof error.hint === "string" ? error.hint : "Task route failed without a hint."
    }
  };
}

function isSqliteTaskProjectionRow(value: unknown): value is TaskProjectionRow {
  return isGuiRecord(value)
    && value.schema === "sqlite-task-row/v1"
    && typeof value.taskId === "string"
    && typeof value.title === "string"
    && typeof value.coordinationStatus === "string"
    && typeof value.closeoutReadiness === "string"
    && (value.parentTaskId === undefined || typeof value.parentTaskId === "string");
}

function isCommandReceiptEnvelope(value: unknown): value is CommandReceiptEnvelope {
  return isGuiRecord(value)
    && value.schema === commandReceiptEnvelope
    && typeof value.ok === "boolean";
}

function isDocumentDescriptor(value: unknown): value is { readonly path: string } {
  return isGuiRecord(value) && typeof value.path === "string";
}

function invalidTaskRouteResult(code: string, hint: string): GuiTaskRouteFailure {
  return { ok: false, error: { code, hint } };
}

function fallbackCommandSummary(ok: boolean): string {
  return ok ? "Command completed." : "Command failed.";
}

function isGuiRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
