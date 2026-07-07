import type {
  AppendTaskProgressPayload,
  LocalControllerResult,
  SetTaskStatusPayload,
  TaskDetailResult,
  TaskDocumentPayload,
  TaskDocumentResult,
  TaskIdPayload,
  TaskListResult,
  ProjectionWarning,
  TaskProjectionRow
} from "../api/renderer-dto.ts";

type HarnessBridgeMethod =
  | "getTasks"
  | "getTaskDetail"
  | "getTaskDocument"
  | "setTaskStatus"
  | "reviewTask"
  | "appendTaskProgress"
  | "rebuildGovernance";

type HarnessBridge = Record<HarnessBridgeMethod, (payload?: object | null) => Promise<unknown>> & {
  readonly capabilities?: unknown;
};

declare global {
  interface Window {
    readonly harness?: HarnessBridge;
  }
}

export interface TaskListSuccess {
  readonly ok: true;
  readonly tasks: ReadonlyArray<TaskProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface TaskDetailSuccess {
  readonly ok: true;
  readonly task: TaskProjectionRow;
  readonly documents: ReadonlyArray<{ readonly path: string }>;
}

export interface TaskDocumentSuccess {
  readonly ok: true;
  readonly taskId: string;
  readonly path: string;
  readonly body: string;
}

export interface CommandSuccess {
  readonly ok: true;
}

export interface CommandFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly hint: string;
  };
}

export type CommandResult = CommandSuccess | CommandFailure;

export const harnessClient = {
  async getTasks(): Promise<TaskListSuccess> {
    const result = await invokeBridge("getTasks", null);
    return readTaskListResult(result);
  },
  async getTaskDetail(payload: TaskIdPayload): Promise<TaskDetailSuccess> {
    const result = await invokeBridge("getTaskDetail", payload);
    return readTaskDetailResult(result);
  },
  async getTaskDocument(payload: TaskDocumentPayload): Promise<TaskDocumentSuccess> {
    const result = await invokeBridge("getTaskDocument", payload);
    return readTaskDocumentResult(result);
  },
  async setTaskStatus(payload: SetTaskStatusPayload): Promise<CommandResult> {
    return readCommandResult(await invokeBridge("setTaskStatus", payload));
  },
  async reviewTask(payload: TaskIdPayload): Promise<CommandResult> {
    return readCommandResult(await invokeBridge("reviewTask", payload));
  },
  async appendTaskProgress(payload: AppendTaskProgressPayload): Promise<CommandResult> {
    return readCommandResult(await invokeBridge("appendTaskProgress", payload));
  },
  async rebuildGovernance(): Promise<TaskListSuccess> {
    const result = await invokeBridge("rebuildGovernance", null);
    return readTaskListResult(result);
  }
};

async function invokeBridge(method: HarnessBridgeMethod, payload: object | null): Promise<unknown> {
  const bridge = window.harness;
  if (!bridge || typeof bridge[method] !== "function") {
    throw new Error(`Harness preload bridge is unavailable for ${method}.`);
  }
  return bridge[method](payload);
}

function readTaskListResult(value: unknown): TaskListSuccess {
  const result = value as TaskListResult;
  if (!result || typeof result !== "object" || result.ok !== true || !Array.isArray(result.tasks)) {
    throw new Error(localErrorHint(value, "Task list bridge returned an invalid result."));
  }
  const tasks = result.tasks.filter(isTaskProjectionRow);
  if (tasks.length !== result.tasks.length) {
    throw new Error("Task list bridge returned rows outside sqlite-task-row/v1.");
  }
  return {
    ok: true,
    tasks,
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

function readTaskDetailResult(value: unknown): TaskDetailSuccess {
  const result = value as TaskDetailResult;
  if (!result || typeof result !== "object" || result.ok !== true || !isTaskProjectionRow(result.task)) {
    throw new Error(localErrorHint(value, "Task detail bridge returned an invalid result."));
  }
  return {
    ok: true,
    task: result.task,
    documents: Array.isArray(result.documents)
      ? result.documents.filter((entry): entry is { readonly path: string } => typeof entry?.path === "string")
      : []
  };
}

function readTaskDocumentResult(value: unknown): TaskDocumentSuccess {
  const result = value as TaskDocumentResult;
  if (!result || typeof result !== "object" || result.ok !== true) {
    throw new Error(localErrorHint(value, "Task document bridge returned an invalid result."));
  }
  return {
    ok: true,
    taskId: typeof result.taskId === "string" ? result.taskId : "",
    path: typeof result.path === "string" ? result.path : "",
    body: typeof result.body === "string" ? result.body : ""
  };
}

function readCommandResult(value: unknown): CommandResult {
  const result = value as LocalControllerResult;
  if (result && typeof result === "object" && result.ok === true) return { ok: true };
  if (result && typeof result === "object" && result.ok === false && result.error) {
    return {
      ok: false,
      error: {
        code: String(result.error.code),
        hint: String(result.error.hint)
      }
    };
  }
  return {
    ok: false,
    error: {
      code: "invalid_bridge_result",
      hint: "The GUI bridge returned an unrecognized command result."
    }
  };
}

function isTaskProjectionRow(value: unknown): value is TaskProjectionRow {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as TaskProjectionRow).schema === "sqlite-task-row/v1" &&
    typeof (value as TaskProjectionRow).taskId === "string" &&
    typeof (value as TaskProjectionRow).title === "string"
  );
}

function localErrorHint(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === false) {
    const error = (value as { error?: { hint?: unknown } }).error;
    if (typeof error?.hint === "string") return error.hint;
  }
  return fallback;
}
