import type {
  DecisionProjectionRow,
  FactAnchorRow, FactProjectionRow,
  GuiActionResult, GuiSubmissionV1,
  GuiBridgeMethod,
  ProjectionWarning,
  RelationCoverageRow,
  RelationGraphEdgeRow,
  RelationType,
  TaskDocumentProjectionRead, TaskSnapshotProjectionRow
} from "../api/renderer-dto.ts";

type HarnessBridge = Record<GuiBridgeMethod, (payload?: object | null) => Promise<unknown>> & {
  readonly capabilities?: unknown;
};

declare global {
  interface Window {
    readonly harness?: HarnessBridge;
  }
}

export interface TaskListSuccess {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly rows: ReadonlyArray<TaskSnapshotProjectionRow>;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface RelationGraphSuccess {
  readonly ok: true;
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>; readonly facts: ReadonlyArray<FactProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface DecisionListSuccess {
  readonly ok: true;
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface DecisionControlListSuccess {
  readonly status: "ready" | "pending";
  readonly decisionIds: ReadonlyArray<string>;
  readonly opId: string;
  readonly hint?: string;
}

export interface DecisionProposalInput {
  readonly title: string;
  readonly question: string;
  readonly riskTier: "low" | "medium" | "high";
  readonly urgency: "low" | "medium" | "high";
  readonly vertical: string;
  readonly preset: string;
  readonly decisionClass: "ordinary" | "standing_policy";
  readonly appliesTo: { readonly modules: readonly string[]; readonly productLines: readonly string[] };
  readonly chosen: ReadonlyArray<{ readonly id: string; readonly text: string; readonly rationale?: string }>;
  readonly rejected: ReadonlyArray<{ readonly id: string; readonly text: string; readonly whyNot: string }>;
  readonly body: string;
  readonly claims: ReadonlyArray<{ readonly id: string; readonly text: string; readonly loadBearing: boolean }>;
  readonly fulfillments: ReadonlyArray<{ readonly claimId: string; readonly mode: "evidenced" | "delivered" | "standing_policy" }>;
  readonly relations: ReadonlyArray<{ readonly anchor: string; readonly type: RelationType; readonly target: string; readonly rationale: string }>;
}

export const harnessClient = {
  async getTasks(): Promise<TaskListSuccess> { return readTaskListResult(await invokeBridge("getTasks")); },
  async getTaskDocument(payload: { readonly taskId: string; readonly path: string }): Promise<TaskDocumentProjectionRead> { return readTaskDocumentResult(await invokeBridge("getTaskDocument", payload)); },
  async getRelationGraph(): Promise<RelationGraphSuccess> { return readRelationGraphResult(await invokeBridge("getRelationGraph")); },
  async getDecisions(): Promise<DecisionListSuccess> { return readDecisionListResult(await invokeBridge("getDecisions")); },
  async listDecisionControls(payload: { readonly search?: string; readonly state?: string; readonly module?: string; readonly productLine?: string }): Promise<DecisionControlListSuccess> { return readDecisionControlList(await invokeBridge("listDecisions", payload)); },
  async showDecision(payload: { readonly decisionId: string; readonly includeBody?: boolean }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("showDecision", payload)); },
  async proposeDecision(payload: DecisionProposalInput): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("proposeDecision", payload)); },
  async acceptDecision(payload: { readonly decisionId: string; readonly rationale: string; readonly judgmentOnlyRationale?: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("acceptDecision", payload)); },
  async rejectDecision(payload: { readonly decisionId: string; readonly reason: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("rejectDecision", payload)); },
  async deferDecision(payload: { readonly decisionId: string; readonly reason: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("deferDecision", payload)); },
  async startTask(payload: { readonly taskId: string; readonly executionId: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("startTask", payload)); },
  async appendTaskProgress(payload: { readonly taskId: string; readonly executionId?: string; readonly text: string; readonly evidence?: ReadonlyArray<{ readonly type: string; readonly path: string; readonly summary: string }>; readonly baseDocumentSha256?: string | null }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("appendTaskProgress", payload)); },
  async submitTask(payload: { readonly taskId: string; readonly executionId: string; readonly submission: GuiSubmissionV1 }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("submitTask", payload)); },
  async showReceipt(payload: { readonly opId: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("showReceipt", payload)); }
};

async function invokeBridge(method: GuiBridgeMethod, payload: object | null = null): Promise<unknown> { const bridge = window.harness;
  if (!bridge || typeof bridge[method] !== "function") throw new Error(`Harness preload bridge is unavailable for ${method}.`);
  return bridge[method](payload);
}

function readTaskDocumentResult(value: unknown): TaskDocumentProjectionRead { const result = value as Partial<TaskDocumentProjectionRead>; if (!result || result.ok !== true || (result.status !== "ready" && result.status !== "pending") || typeof result.taskId !== "string" || typeof result.path !== "string" || typeof result.body !== "string" || !Number.isInteger(result.watermark) || !Number.isInteger(result.sourceRevision)) throw new Error(localErrorHint(value, "Task document bridge returned an invalid result.")); return result as TaskDocumentProjectionRead; }

function readTaskListResult(value: unknown): TaskListSuccess {
  const result = value as Partial<TaskListSuccess>;
  if (!result || result.ok !== true || !Array.isArray(result.rows) || !result.rows.every(isTaskSnapshotProjectionRow)
    || (result.status !== "ready" && result.status !== "pending") || !Number.isInteger(result.watermark) || !Number.isInteger(result.sourceRevision)) {
    throw new Error(localErrorHint(value, "Task list bridge returned an invalid result."));
  }
  return {
    ok: true,
    status: result.status as "ready" | "pending",
    rows: result.rows,
    watermark: result.watermark as number,
    sourceRevision: result.sourceRevision as number,
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((warning): warning is string => typeof warning === "string") : []
  };
}

function readRelationGraphResult(value: unknown): RelationGraphSuccess {
  const result = value as Partial<RelationGraphSuccess>;
  if (!result || result.ok !== true || !Array.isArray(result.edges) || !Array.isArray(result.coverageRows) || !Array.isArray(result.factAnchors) || !Array.isArray(result.facts)) {
    throw new Error(localErrorHint(value, "Relation graph bridge returned an invalid result."));
  }
  return {
    ok: true,
    edges: result.edges.filter(isRelationGraphEdgeRow),
    coverageRows: result.coverageRows.filter(isRelationCoverageRow),
    factAnchors: result.factAnchors.filter(isFactAnchorRow), facts: result.facts,
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

function readDecisionListResult(value: unknown): DecisionListSuccess {
  const result = value as Partial<DecisionListSuccess>;
  if (!result || result.ok !== true || !Array.isArray(result.decisions)) {
    throw new Error(localErrorHint(value, "Decision list bridge returned an invalid result."));
  }
  return {
    ok: true,
    decisions: result.decisions.filter(isDecisionProjectionRow),
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}

function readGuiActionResult(value: unknown): GuiActionResult {
  const result = value as Partial<GuiActionResult>;
  if (!result || result.schema !== "command-receipt/v2" || typeof result.ok !== "boolean" || typeof result.command !== "string"
    || !["applied", "pending", "indeterminate", "rejected"].includes(String(result.outcome)) || typeof result.opId !== "string") {
    throw new Error(localErrorHint(value, "GUI action bridge returned an invalid receipt."));
  }
  return result as GuiActionResult;
}

function readDecisionControlList(value: unknown): DecisionControlListSuccess {
  const receipt = readGuiActionResult(value) as GuiActionResult & { readonly evidence?: string; readonly nextAction?: string; readonly error?: { readonly code?: string; readonly hint?: string } };
  if (receipt.outcome === "rejected" || receipt.outcome === "indeterminate") throw new Error(`${receipt.error?.code ?? receipt.outcome}: ${receipt.error?.hint ?? receipt.nextAction ?? "Decision list failed."}`);
  try {
    const evidence = JSON.parse(receipt.evidence ?? "") as { readonly status?: unknown; readonly decisions?: unknown };
    if ((evidence.status !== "ready" && evidence.status !== "pending") || !Array.isArray(evidence.decisions)) throw new Error();
    const decisionIds = evidence.decisions.flatMap((item) => record(item) && typeof item.decisionId === "string" ? [item.decisionId] : []);
    return { status: evidence.status, decisionIds, opId: receipt.opId, ...(receipt.nextAction ? { hint: receipt.nextAction } : {}) };
  } catch { throw new Error("Decision list receipt evidence is invalid."); }
}

function isTaskSnapshotProjectionRow(value: unknown): value is TaskSnapshotProjectionRow {
  if (!record(value) || typeof value.taskId !== "string" || typeof value.updatedAt !== "string" || !record(value.snapshot)) return false;
  const task = value.snapshot.task;
  return record(task) && task.schema === "task/v1" && task.taskId === value.taskId && typeof task.title === "string";
}

function isDecisionProjectionRow(value: unknown): value is DecisionProjectionRow {
  return record(value) && value.schema === "decision-row/v1" && typeof value.decisionId === "string" && typeof value.title === "string" && typeof value.state === "string" && Number.isInteger(value.workspaceRevision) && Array.isArray(value.claims);
}

function isRelationGraphEdgeRow(value: unknown): value is RelationGraphEdgeRow {
  return record(value) && typeof value.sourceRef === "string" && typeof value.targetRef === "string"
    && typeof value.relationType === "string";
}

function isRelationCoverageRow(value: unknown): value is RelationCoverageRow {
  return record(value) && typeof value.decisionRef === "string" && typeof value.claimRef === "string" && typeof value.status === "string" && (value.fulfillment === null || ["evidenced", "delivered", "standing_policy"].includes(String(value.fulfillment))) && Array.isArray(value.refutingFactRefs) && Array.isArray(value.relationPath) && Number.isInteger(value.basisRevision);
}

function isFactAnchorRow(value: unknown): value is FactAnchorRow {
  return record(value) && typeof value.factRef === "string" && typeof value.taskId === "string"
    && typeof value.factId === "string";
}

function localErrorHint(value: unknown, fallback: string): string {
  if (record(value) && value.ok === false && record(value.error) && typeof value.error.hint === "string") return value.error.hint;
  return fallback;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
