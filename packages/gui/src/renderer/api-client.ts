import type {
  AppendTaskProgressPayload,
  CatalogSnapshotResult,
  CatalogSnapshotSuccess,
  DecisionMutationResult,
  DecisionProposePayload,
  DecisionTransitionPayload,
  LocalControllerResult,
  SetTaskStatusPayload,
  TaskDetailResult,
  TaskDocumentPayload,
  TaskDocumentResult,
  TaskIdPayload,
  TaskListResult,
  TaskExecutionListResult,
  ExecutionDetailResult,
  ExecutionEvidencePagePayload,
  ExecutionIdPayload,
  ExecutionProjectionRow,
  DecisionIdPayload,
  DecisionListResult,
  DecisionProjectionRow,
  DecisionDetailResult,
  FactProjectionRow,
  FactListResult,
  TriadicProjectionResult,
  RelationGraphReadResult,
  RelationGraphEdgeRow,
  RelationCoverageRow,
  FactAnchorRow,
  TaskFactListResult,
  ProjectionWarning,
  TaskProjectionRow
} from "../api/renderer-dto.ts";
import { t } from "./i18n/core.ts";
import {
  readExecutionEvidencePageResult,
  type ExecutionEvidencePageSuccess
} from "./execution-evidence-api-contract.ts";
export type { ExecutionEvidencePageSuccess } from "./execution-evidence-api-contract.ts";

type HarnessBridgeMethod =
  | "getCatalogSnapshot"
  | "getTasks"
  | "getTaskDetail"
  | "getTaskDocument"
  | "getRelationGraph"
  | "getTriadicProjection"
  | "getDecisions"
  | "getDecisionDetail"
  | "proposeDecision"
  | "acceptDecision"
  | "rejectDecision"
  | "deferDecision"
  | "getTaskFacts"
  | "getFacts"
  | "getTaskExecutions"
  | "getExecutions"
  | "getExecutionEvidencePage"
  | "getExecutionDetail"
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

export interface RelationGraphSuccess {
  readonly ok: true;
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface DecisionListSuccess {
  readonly ok: true;
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface DecisionDetailSuccess {
  readonly ok: true;
  readonly decision: DecisionProjectionRow;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface TaskFactListSuccess {
  readonly ok: true;
  readonly taskId: string;
  readonly path: string;
  readonly facts: ReadonlyArray<FactProjectionRow>;
}

export interface FactListSuccess {
  readonly ok: true;
  readonly facts: ReadonlyArray<FactProjectionRow>;
}

export interface TriadicProjectionSuccess extends RelationGraphSuccess {
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly facts: ReadonlyArray<FactProjectionRow>;
}

export interface TaskExecutionListSuccess {
  readonly ok: true;
  readonly taskId: string;
  readonly executions: ReadonlyArray<ExecutionProjectionRow>;
}

export interface ExecutionListSuccess {
  readonly ok: true;
  readonly executions: ReadonlyArray<ExecutionProjectionRow>;
}

export interface ExecutionDetailSuccess {
  readonly ok: true;
  readonly execution: ExecutionProjectionRow;
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
  async getCatalogSnapshot(): Promise<CatalogSnapshotSuccess> {
    return readCatalogSnapshotResult(await invokeBridge("getCatalogSnapshot", null));
  },
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
  async getRelationGraph(): Promise<RelationGraphSuccess> {
    const result = await invokeBridge("getRelationGraph", null);
    return readRelationGraphResult(result);
  },
  async getTriadicProjection(): Promise<TriadicProjectionSuccess> {
    const result = await invokeBridge("getTriadicProjection", null);
    return readTriadicProjectionResult(result);
  },
  async getDecisions(): Promise<DecisionListSuccess> {
    const result = await invokeBridge("getDecisions", null);
    return readDecisionListResult(result);
  },
  async getDecisionDetail(payload: DecisionIdPayload): Promise<DecisionDetailSuccess> {
    const result = await invokeBridge("getDecisionDetail", payload);
    return readDecisionDetailResult(result);
  },
  async proposeDecision(payload: DecisionProposePayload): Promise<DecisionMutationResult> {
    return readDecisionMutationResult(await invokeBridge("proposeDecision", payload));
  },
  async acceptDecision(payload: DecisionTransitionPayload): Promise<DecisionMutationResult> {
    return readDecisionMutationResult(await invokeBridge("acceptDecision", payload));
  },
  async rejectDecision(payload: DecisionTransitionPayload): Promise<DecisionMutationResult> {
    return readDecisionMutationResult(await invokeBridge("rejectDecision", payload));
  },
  async deferDecision(payload: DecisionTransitionPayload): Promise<DecisionMutationResult> {
    return readDecisionMutationResult(await invokeBridge("deferDecision", payload));
  },
  async getTaskFacts(payload: TaskIdPayload): Promise<TaskFactListSuccess> {
    const result = await invokeBridge("getTaskFacts", payload);
    return readTaskFactListResult(result);
  },
  async getFacts(): Promise<FactListSuccess> {
    const result = await invokeBridge("getFacts", null);
    return readFactListResult(result);
  },
  async getTaskExecutions(payload: TaskIdPayload): Promise<TaskExecutionListSuccess> {
    const result = await invokeBridge("getTaskExecutions", payload);
    return readTaskExecutionListResult(result);
  },
  async getExecutions(): Promise<ExecutionListSuccess> {
    const result = await invokeBridge("getExecutions", null);
    return readExecutionListResult(result);
  },
  async getExecutionEvidencePage(payload: ExecutionEvidencePagePayload): Promise<ExecutionEvidencePageSuccess> {
    const result = await invokeBridge("getExecutionEvidencePage", payload);
    return readExecutionEvidencePageResult(result);
  },
  async getExecutionDetail(payload: ExecutionIdPayload): Promise<ExecutionDetailSuccess> {
    const result = await invokeBridge("getExecutionDetail", payload);
    return readExecutionDetailResult(result);
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

function readCatalogSnapshotResult(value: unknown): CatalogSnapshotSuccess {
  const result = value as CatalogSnapshotResult;
  if (
    !result || typeof result !== "object" || result.ok !== true ||
    typeof result.activeVerticalId !== "string" || result.customVerticalsImplemented !== false ||
    !Array.isArray(result.presets) || !Array.isArray(result.verticals) ||
    !Array.isArray(result.templates) || !Array.isArray(result.adapters)
  ) throw new Error(localErrorHint(value, "Catalog snapshot bridge returned an invalid result."));
  if (result.adapters.some((adapter) => adapter.id !== "local" && adapter.id !== "multica")) {
    throw new Error("Catalog snapshot bridge returned an unregistered adapter id.");
  }
  return result;
}

function readDecisionMutationResult(value: unknown): DecisionMutationResult {
  const result = value as DecisionMutationResult;
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    return { ok: false, error: { code: "invalid_result", hint: t("renderer.apiClient.invalidDecisionMutationResult") } };
  }
  if (!result.ok) return result;
  if (typeof result.decisionId !== "string" || typeof result.state !== "string") {
    return { ok: false, error: { code: "invalid_result", hint: t("renderer.apiClient.missingDecisionIdOrState") } };
  }
  return result;
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

function readRelationGraphResult(value: unknown): RelationGraphSuccess {
  const result = value as RelationGraphReadResult;
  if (!result || typeof result !== "object" || result.ok !== true || !Array.isArray(result.edges) || !Array.isArray(result.coverageRows) || !Array.isArray(result.factAnchors)) {
    throw new Error(localErrorHint(value, "Relation graph bridge returned an invalid result."));
  }
  return {
    ok: true,
    edges: result.edges.filter(isRelationGraphEdgeRow),
    coverageRows: result.coverageRows.filter(isRelationCoverageRow),
    factAnchors: result.factAnchors.filter(isFactAnchorRow),
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

function readTriadicProjectionResult(value: unknown): TriadicProjectionSuccess {
  const result = value as TriadicProjectionResult;
  if (
    !result || typeof result !== "object" || result.ok !== true ||
    !Array.isArray(result.decisions) || !Array.isArray(result.edges) ||
    !Array.isArray(result.coverageRows) || !Array.isArray(result.factAnchors) ||
    !Array.isArray(result.facts)
  ) {
    throw new Error(localErrorHint(value, "Triadic projection bridge returned an invalid result."));
  }
  const decisions = result.decisions.filter(isDecisionProjectionRow);
  const edges = result.edges.filter(isRelationGraphEdgeRow);
  const coverageRows = result.coverageRows.filter(isRelationCoverageRow);
  const factAnchors = result.factAnchors.filter(isFactAnchorRow);
  const facts = result.facts.filter(isFactProjectionRow);
  if (
    decisions.length !== result.decisions.length || edges.length !== result.edges.length ||
    coverageRows.length !== result.coverageRows.length || factAnchors.length !== result.factAnchors.length ||
    facts.length !== result.facts.length
  ) {
    throw new Error("Triadic projection bridge returned rows outside projection DTO shapes.");
  }
  return {
    ok: true,
    decisions,
    edges,
    coverageRows,
    factAnchors,
    facts,
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

function readDecisionListResult(value: unknown): DecisionListSuccess {
  const result = value as DecisionListResult;
  if (!result || typeof result !== "object" || result.ok !== true || !Array.isArray(result.decisions)) {
    throw new Error(localErrorHint(value, "Decision list bridge returned an invalid result."));
  }
  return {
    ok: true,
    decisions: result.decisions.filter(isDecisionProjectionRow),
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

function readDecisionDetailResult(value: unknown): DecisionDetailSuccess {
  const result = value as DecisionDetailResult;
  if (!result || typeof result !== "object" || result.ok !== true || !isDecisionProjectionRow(result.decision)) {
    throw new Error(localErrorHint(value, "Decision detail bridge returned an invalid result."));
  }
  return {
    ok: true,
    decision: result.decision,
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

function readTaskFactListResult(value: unknown): TaskFactListSuccess {
  const result = value as TaskFactListResult;
  if (!result || typeof result !== "object" || result.ok !== true || typeof result.taskId !== "string" || !Array.isArray(result.facts)) {
    throw new Error(localErrorHint(value, "Task facts bridge returned an invalid result."));
  }
  const facts = result.facts.filter(isFactProjectionRow);
  if (facts.length !== result.facts.length) {
    throw new Error("Task facts bridge returned rows outside task-fact-row/v1.");
  }
  return {
    ok: true,
    taskId: result.taskId,
    path: typeof result.path === "string" ? result.path : "",
    facts
  };
}

function readFactListResult(value: unknown): FactListSuccess {
  const result = value as FactListResult;
  if (!result || typeof result !== "object" || result.ok !== true || !Array.isArray(result.facts)) {
    throw new Error(localErrorHint(value, "Facts bridge returned an invalid result."));
  }
  const facts = result.facts.filter(isFactProjectionRow);
  if (facts.length !== result.facts.length) {
    throw new Error("Facts bridge returned rows outside fact projection shape.");
  }
  return { ok: true, facts };
}

function readTaskExecutionListResult(value: unknown): TaskExecutionListSuccess {
  const result = value as TaskExecutionListResult;
  if (!result || typeof result !== "object" || result.ok !== true || typeof result.taskId !== "string" || !Array.isArray(result.executions)) {
    throw new Error(localErrorHint(value, "Task executions bridge returned an invalid result."));
  }
  const executions = result.executions.filter(isExecutionProjectionRow);
  if (executions.length !== result.executions.length) {
    throw new Error("Task executions bridge returned rows outside execution projection shape.");
  }
  return {
    ok: true,
    taskId: result.taskId,
    executions
  };
}

function readExecutionListResult(value: unknown): ExecutionListSuccess {
  const result = value as { readonly ok?: boolean; readonly executions?: ReadonlyArray<unknown> };
  if (!result || typeof result !== "object" || result.ok !== true || !Array.isArray(result.executions)) {
    throw new Error(localErrorHint(value, "Executions bridge returned an invalid result."));
  }
  const executions = result.executions.filter(isExecutionProjectionRow);
  if (executions.length !== result.executions.length) {
    throw new Error("Executions bridge returned rows outside execution projection shape.");
  }
  return { ok: true, executions };
}

function readExecutionDetailResult(value: unknown): ExecutionDetailSuccess {
  const result = value as ExecutionDetailResult;
  if (!result || typeof result !== "object" || result.ok !== true || !isExecutionProjectionRow(result.execution)) {
    throw new Error(localErrorHint(value, "Execution detail bridge returned an invalid result."));
  }
  return {
    ok: true,
    execution: result.execution
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
      hint: t("renderer.apiClient.unrecognizedCommandResult")
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

function isDecisionProjectionRow(value: unknown): value is DecisionProjectionRow {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as DecisionProjectionRow).schema === "d4-decision-row/v1" &&
    typeof (value as DecisionProjectionRow).decisionId === "string" &&
    typeof (value as DecisionProjectionRow).title === "string" &&
    typeof (value as DecisionProjectionRow).state === "string"
  );
}

function isRelationGraphEdgeRow(value: unknown): value is RelationGraphEdgeRow {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as RelationGraphEdgeRow).sourceRef === "string" &&
    typeof (value as RelationGraphEdgeRow).targetRef === "string" &&
    typeof (value as RelationGraphEdgeRow).relationType === "string"
  );
}

function isRelationCoverageRow(value: unknown): value is RelationCoverageRow {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as RelationCoverageRow).decisionRef === "string" &&
    typeof (value as RelationCoverageRow).claimRef === "string" &&
    typeof (value as RelationCoverageRow).status === "string"
  );
}

function isFactAnchorRow(value: unknown): value is FactAnchorRow {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as FactAnchorRow).factRef === "string" &&
    typeof (value as FactAnchorRow).taskId === "string" &&
    typeof (value as FactAnchorRow).factId === "string"
  );
}

function isFactProjectionRow(value: unknown): value is FactProjectionRow {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as FactProjectionRow).schema === "task-fact-row/v1" &&
    typeof (value as FactProjectionRow).ref === "string" &&
    typeof (value as FactProjectionRow).taskId === "string" &&
    typeof (value as FactProjectionRow).factId === "string" &&
    typeof (value as FactProjectionRow).statement === "string"
  );
}

function isExecutionProjectionRow(value: unknown): value is ExecutionProjectionRow {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as ExecutionProjectionRow).executionId === "string" &&
    typeof (value as ExecutionProjectionRow).taskRef === "string" &&
    typeof (value as ExecutionProjectionRow).taskId === "string" &&
    typeof (value as ExecutionProjectionRow).state === "string" &&
    typeof (value as ExecutionProjectionRow).claimedAt === "string" &&
    Array.isArray((value as ExecutionProjectionRow).outputs) &&
    Array.isArray((value as ExecutionProjectionRow).sessionBindings)
  );
}

function localErrorHint(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === false) {
    const error = (value as { error?: { hint?: unknown } }).error;
    if (typeof error?.hint === "string") return error.hint;
  }
  return fallback;
}
