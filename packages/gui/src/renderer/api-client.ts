import type {
  DecisionProjectionRow,
  FactAnchorRow, RelationFactRow,
  GuiActionResult, GuiSubmissionV1,
  GuiBridgeMethod,
  ProjectionWarning,
  RelationCoverageRow,
  RelationGraphEdgeRow,
  RelationType,
  TaskDocumentListProjectionRead, TaskDocumentProjectionRead, TaskDispatchesRead, TaskSnapshotProjectionRow, WorkspaceSummaryRead
} from "../api/renderer-dto.ts";
import { isRendererRecord } from "./result-validation.ts";

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
  readonly page?: QueryPage;
}

export interface RelationGraphSuccess {
  readonly ok: true;
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>; readonly facts: ReadonlyArray<RelationFactRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
  readonly page?: QueryPage;
}

export interface QueryPage { readonly limit: number; readonly cursor: string | null; readonly nextCursor: string | null }
export type TaskDispatchBatchRead = Extract<TaskDispatchesRead, { readonly taskIds: readonly string[] }>;

/** Optional narrow/paged facets for the wide task reads; omitting them keeps the full result. */
export interface TaskQueryFacets {
  readonly status?: string; readonly changedAfterRevision?: number; readonly updatedAfter?: string; readonly updatedBefore?: string; readonly limit?: number; readonly cursor?: string;
}
export interface RelationQueryFacets { readonly status?: string; readonly updatedAfter?: string; readonly updatedBefore?: string; readonly limit?: number; readonly cursor?: string }

export interface DecisionListSuccess {
  readonly ok: true;
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}
export type WorkspaceSummarySuccess = WorkspaceSummaryRead;

export interface DecisionControlListSuccess {
  readonly status: "ready" | "pending";
  readonly decisionIds: ReadonlyArray<string>;
  readonly opId: string;
  readonly hint?: string;
}

export interface RepoScope { readonly repoId: string }
export interface SystemRepoRow {
  readonly repoId: string; readonly displayName: string; readonly canonicalRoot: string; readonly authoredBranch: string;
  readonly registrationState: "enabled" | "disabled"; readonly cellState: "warming" | "attached" | "unavailable" | "not_loaded";
  readonly generation: number | null; readonly queueDepth: number | null; readonly lockState: "held" | "not_applicable" | "unknown";
  readonly recoveryMs: number | null; readonly lastError: string | null; readonly unavailableReason: string | null;
}
export interface DaemonPoint { readonly daemonId: string; readonly pid: number; readonly startedAt: string }
export interface SystemStatusSuccess {
  readonly schema: "gui-system-status/v1"; readonly ok: true; readonly observedAt: string;
  readonly daemon: DaemonPoint & { readonly protocolVersion: number; readonly uptimeMs: number; readonly endpoint: string; readonly build: { readonly version: string; readonly commitSha: string | null }; readonly buildStale?: null | { readonly daemonCommit: string; readonly clientCommit: string }; readonly userRoot?: string; readonly activeControl: null | { readonly kind: "refresh" | "restart"; readonly operationId: string; readonly phase: DaemonControlReceipt["phase"]; readonly requestedAt: string; readonly error: BridgeError | null } };
  readonly repos: ReadonlyArray<SystemRepoRow>;
}
export interface BridgeError { readonly code: string; readonly hint: string }
export interface DaemonControlReceipt {
  readonly schema: "daemon-control-receipt/v1"; readonly ok: boolean; readonly outcome: "pending" | "op_rejected";
  readonly kind: "refresh" | "restart"; readonly operationId: string; readonly phase: "queued" | "draining" | "starting" | "settled" | "failed";
  readonly requestedAt: string; readonly completedAt: string | null; readonly before: DaemonPoint | null; readonly after: DaemonPoint | null;
  readonly error: BridgeError | null; readonly nextAction: string | null;
}
export interface CatalogPresetRow { readonly id: string; readonly title: string; readonly description: string; readonly verticalId: string; readonly sourceKind: "bundled" | "user" | "user-shadow"; readonly validity: "valid" | "unavailable" | "blocked"; readonly version: string | null; readonly kind: string | null; readonly defaultProfile: string | null; readonly entrypoints: ReadonlyArray<string>; readonly issues: ReadonlyArray<unknown>; readonly shadows: { readonly layer: "bundled"; readonly title: string } | null }
export interface CatalogVerticalRow { readonly id: string; readonly title: string; readonly version: string; readonly source: "builtin"; readonly available: boolean; readonly valid: boolean; readonly issues: ReadonlyArray<unknown> }
export interface CatalogTemplateRow { readonly templateRef: string; readonly slot: string; readonly materializeAs: string; readonly locales: ReadonlyArray<string> }
export interface CatalogAdapterRow { readonly adapterId: string; readonly registered: true; readonly capabilities: ReadonlyArray<string>; readonly writability: "read-only" | "read-write" | "unknown"; readonly defaultProvider: boolean; readonly unavailableReason: string | null }
export interface CatalogSnapshotSuccess { readonly schema: "gui-catalog-snapshot/v1"; readonly ok: true; readonly status: "ready" | "pending"; readonly repoId: string; readonly observedAt: string; readonly catalogDigest: string; readonly defaults: { readonly verticalId: string; readonly presetId: string; readonly profileId: string | null; readonly locale: string }; readonly presets: ReadonlyArray<CatalogPresetRow>; readonly verticals: ReadonlyArray<CatalogVerticalRow>; readonly templates: ReadonlyArray<CatalogTemplateRow>; readonly adapters: ReadonlyArray<CatalogAdapterRow> }
export interface CatalogPresetSuccess { readonly schema: "gui-catalog-preset/v1"; readonly ok: true; readonly repoId: string; readonly preset: { readonly id: string; readonly title: string; readonly verticalId: string; readonly version: string | null; readonly extends: string | null; readonly capabilityImports: ReadonlyArray<unknown>; readonly profiles: ReadonlyArray<unknown> }; readonly resolved: { readonly identity: Readonly<Record<string, unknown>>; readonly profile: Readonly<Record<string, unknown>>; readonly templates: ReadonlyArray<unknown>; readonly entrypoints: ReadonlyArray<unknown>; readonly provenance: Readonly<Record<string, unknown>>; readonly digest: string } }
export interface CatalogRereadReceipt { readonly schema: "catalog-reread-receipt/v1"; readonly ok: boolean; readonly outcome: "applied" | "op_rejected"; readonly operationId: string; readonly repoId: string; readonly beforeDigest: string; readonly afterDigest: string; readonly observedAt: string; readonly error: BridgeError | null }

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
  async getSystemStatus(): Promise<SystemStatusSuccess> { return readSystemStatus(await invokeBridge("getSystemStatus")); },
  async requestDaemonControl(payload: { readonly kind: "refresh" | "restart"; readonly authorityRepoId: string; readonly reason?: string }): Promise<DaemonControlReceipt> { return readDaemonControlReceipt(await invokeBridge("requestDaemonControl", payload)); },
  async getDaemonControlReceipt(payload: { readonly operationId: string }): Promise<DaemonControlReceipt> { return readDaemonControlReceipt(await invokeBridge("getDaemonControlReceipt", payload)); },
  async getTasks(payload: RepoScope & TaskQueryFacets): Promise<TaskListSuccess> { return readTaskListResult(await invokeBridge("getTasks", payload)); },
  async getWorkspaceSummary(payload: RepoScope): Promise<WorkspaceSummarySuccess> { return readWorkspaceSummaryResult(await invokeBridge("getWorkspaceSummary", payload)); },
  async getTaskDocument(payload: RepoScope & { readonly taskId: string; readonly path: string }): Promise<TaskDocumentProjectionRead> { return readTaskDocumentResult(await invokeBridge("getTaskDocument", payload)); },
  async getTaskDocuments(payload: RepoScope & { readonly taskId: string }): Promise<TaskDocumentListProjectionRead> { return readTaskDocumentListResult(await invokeBridge("getTaskDocuments", payload)); },
  async getTaskDispatches(payload: RepoScope & ({ readonly taskId: string } | { readonly taskIds: readonly string[]; readonly limit?: number; readonly cursor?: string })): Promise<TaskDispatchesRead> { return readTaskDispatchesResult(await invokeBridge("getTaskDispatches", payload)); },
  async getRelationGraph(payload: RepoScope & RelationQueryFacets): Promise<RelationGraphSuccess> { return readRelationGraphResult(await invokeBridge("getRelationGraph", payload)); },
  async getDecisions(payload: RepoScope): Promise<DecisionListSuccess> { return readDecisionListResult(await invokeBridge("getDecisions", payload)); },
  async listDecisionControls(payload: RepoScope & { readonly search?: string; readonly state?: string; readonly module?: string; readonly productLine?: string }): Promise<DecisionControlListSuccess> { return readDecisionControlList(await invokeBridge("listDecisions", payload)); },
  async showDecision(payload: RepoScope & { readonly decisionId: string; readonly includeBody?: boolean }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("showDecision", payload)); },
  async proposeDecision(payload: RepoScope & DecisionProposalInput): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("proposeDecision", payload)); },
  async acceptDecision(payload: RepoScope & { readonly decisionId: string; readonly rationale: string; readonly judgmentOnlyRationale?: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("acceptDecision", payload)); },
  async rejectDecision(payload: RepoScope & { readonly decisionId: string; readonly reason: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("rejectDecision", payload)); },
  async deferDecision(payload: RepoScope & { readonly decisionId: string; readonly reason: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("deferDecision", payload)); },
  async startTask(payload: RepoScope & { readonly taskId: string; readonly executionId: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("startTask", payload)); },
  async appendTaskProgress(payload: RepoScope & { readonly taskId: string; readonly executionId?: string; readonly text: string; readonly evidence?: ReadonlyArray<{ readonly type: string; readonly path: string; readonly summary: string }>; readonly baseDocumentSha256?: string | null }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("appendTaskProgress", payload)); },
  async submitTask(payload: RepoScope & { readonly taskId: string; readonly executionId: string; readonly submission: GuiSubmissionV1 }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("submitTask", payload)); },
  async showReceipt(payload: RepoScope & { readonly opId: string }): Promise<GuiActionResult> { return readGuiActionResult(await invokeBridge("showReceipt", payload)); },
  async getCatalogSnapshot(payload: RepoScope): Promise<CatalogSnapshotSuccess> { return readCatalogSnapshot(await invokeBridge("getCatalogSnapshot", payload)); },
  async getCatalogPreset(payload: RepoScope & { readonly presetId: string; readonly profileId?: string; readonly locale?: string }): Promise<CatalogPresetSuccess> { return readCatalogPreset(await invokeBridge("getCatalogPreset", payload)); },
  async rereadCatalog(payload: RepoScope & { readonly expectedDigest?: string }): Promise<CatalogRereadReceipt> { return readCatalogRereadReceipt(await invokeBridge("rereadCatalog", payload)); },
};

async function invokeBridge(method: GuiBridgeMethod, payload: object | null = null): Promise<unknown> { const bridge = window.harness;
  if (!bridge || typeof bridge[method] !== "function") throw new Error(`Harness preload bridge is unavailable for ${method}.`);
  return bridge[method](payload);
}

function readTaskDocumentListResult(value: unknown): TaskDocumentListProjectionRead { const result = value as Partial<TaskDocumentListProjectionRead>; if (!result || result.ok !== true || (result.status !== "ready" && result.status !== "pending") || typeof result.taskId !== "string" || !Array.isArray(result.documents) || result.documents.some((doc) => !isRendererRecord(doc) || typeof doc.path !== "string" || typeof doc.blobSha256 !== "string" || !Number.isInteger(doc.size) || typeof doc.mediaType !== "string") || !Number.isInteger(result.watermark) || !Number.isInteger(result.sourceRevision)) throw new Error(localErrorHint(value, "Task document list bridge returned an invalid result.")); return result as TaskDocumentListProjectionRead; }

function readTaskDispatchesResult(value: unknown): TaskDispatchesRead { const result = value as Partial<TaskDispatchesRead> & { readonly taskId?: unknown; readonly taskIds?: unknown; readonly unavailableTaskIds?: unknown; readonly page?: unknown }, taskIds = Array.isArray(result?.taskIds) ? result.taskIds : [], unavailableTaskIds = Array.isArray(result?.unavailableTaskIds) ? result.unavailableTaskIds : [], single = typeof result?.taskId === "string", batch = taskIds.length > 0 && taskIds.every((taskId) => typeof taskId === "string") && unavailableTaskIds.every((taskId) => typeof taskId === "string" && taskIds.includes(taskId)) && isQueryPage(result.page); if (!result || result.ok !== true || (result.status !== "ready" && result.status !== "pending") || single === batch || !Array.isArray(result.dispatches) || result.dispatches.some((row) => !isRendererRecord(row) || typeof row.dispatchId !== "string" || typeof row.runtimeSessionId !== "string" || !["running", "succeeded", "failed", "unknown", "cancelled"].includes(String(row.status))) || !Number.isInteger(result.watermark) || !Number.isInteger(result.sourceRevision)) throw new Error(localErrorHint(value, "Task dispatches bridge returned an invalid result.")); return result as TaskDispatchesRead; }

function readTaskDocumentResult(value: unknown): TaskDocumentProjectionRead { const result = value as Partial<TaskDocumentProjectionRead>; if (!result || result.ok !== true || (result.status !== "ready" && result.status !== "pending") || typeof result.taskId !== "string" || typeof result.path !== "string" || typeof result.body !== "string" || !Number.isInteger(result.watermark) || !Number.isInteger(result.sourceRevision)) throw new Error(localErrorHint(value, "Task document bridge returned an invalid result.")); return result as TaskDocumentProjectionRead; }

function readTaskListResult(value: unknown): TaskListSuccess {
  const result = value as Partial<TaskListSuccess>;
  if (!result || result.ok !== true || !Array.isArray(result.rows) || !result.rows.every(isTaskSnapshotProjectionRow)
    || (result.status !== "ready" && result.status !== "pending") || !Number.isInteger(result.watermark) || !Number.isInteger(result.sourceRevision) || result.page !== undefined && !isQueryPage(result.page)) {
    throw new Error(localErrorHint(value, "Task list bridge returned an invalid result."));
  }
  return {
    ok: true,
    status: result.status as "ready" | "pending",
    rows: result.rows,
    watermark: result.watermark as number,
    sourceRevision: result.sourceRevision as number,
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((warning): warning is string => typeof warning === "string") : [],
    ...(result.page ? { page: result.page } : {})
  };
}

function readWorkspaceSummaryResult(value: unknown): WorkspaceSummarySuccess {
  const result = value as Partial<WorkspaceSummarySuccess>;
  if (!result || result.schema !== "daemon.workspace-summary/v1" || result.ok !== true || (result.status !== "ready" && result.status !== "pending")
    || !isRendererRecord(result.tasks) || !Number.isInteger(result.tasks.total) || !isRendererRecord(result.tasks.byStatus)
    || !isRendererRecord(result.decisions) || !Number.isInteger(result.decisions.total) || !Number.isInteger(result.decisions.inboxCount)
    || !isRendererRecord(result.decisions.byState) || !Array.isArray(result.decisions.groups)
    || !Number.isInteger(result.watermark) || !Number.isInteger(result.sourceRevision)) {
    throw new Error(localErrorHint(value, "Workspace summary bridge returned an invalid result."));
  }
  return result as WorkspaceSummarySuccess;
}

function readRelationGraphResult(value: unknown): RelationGraphSuccess {
  const result = value as Partial<RelationGraphSuccess>;
  if (!result || result.ok !== true || !Array.isArray(result.edges) || !Array.isArray(result.coverageRows) || !Array.isArray(result.factAnchors) || !Array.isArray(result.facts) || result.page !== undefined && !isQueryPage(result.page)) {
    throw new Error(localErrorHint(value, "Relation graph bridge returned an invalid result."));
  }
  return {
    ok: true,
    edges: result.edges.filter(isRelationGraphEdgeRow),
    coverageRows: result.coverageRows.filter(isRelationCoverageRow),
    factAnchors: result.factAnchors.filter(isFactAnchorRow), facts: result.facts,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    ...(result.page ? { page: result.page } : {})
  };
}

function isQueryPage(value: unknown): value is QueryPage {
  return isRendererRecord(value) && typeof value.limit === "number" && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 500
    && (value.cursor === null || typeof value.cursor === "string")
    && (value.nextCursor === null || typeof value.nextCursor === "string");
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
    || !["applied", "pending", "indeterminate", "op_rejected"].includes(String(result.outcome)) || typeof result.opId !== "string") {
    throw new Error(localErrorHint(value, "GUI action bridge returned an invalid receipt."));
  }
  return result as GuiActionResult;
}

function readDecisionControlList(value: unknown): DecisionControlListSuccess {
  const receipt = readGuiActionResult(value) as GuiActionResult & { readonly evidence?: string; readonly nextAction?: string; readonly error?: { readonly code?: string; readonly hint?: string } };
  if (receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate") throw new Error(`${receipt.error?.code ?? receipt.outcome}: ${receipt.error?.hint ?? receipt.nextAction ?? "Decision list failed."}`);
  try {
    const evidence = JSON.parse(receipt.evidence ?? "") as { readonly status?: unknown; readonly decisions?: unknown };
    if ((evidence.status !== "ready" && evidence.status !== "pending") || !Array.isArray(evidence.decisions)) throw new Error();
    const decisionIds = evidence.decisions.flatMap((item) => isRendererRecord(item) && typeof item.decisionId === "string" ? [item.decisionId] : []);
    return { status: evidence.status, decisionIds, opId: receipt.opId, ...(receipt.nextAction ? { hint: receipt.nextAction } : {}) };
  } catch { throw new Error("Decision list receipt evidence is invalid."); }
}

function readSystemStatus(value: unknown): SystemStatusSuccess {
  if (!isRendererRecord(value) || value.schema !== "gui-system-status/v1" || value.ok !== true || typeof value.observedAt !== "string" || !isRendererRecord(value.daemon) || !Array.isArray(value.repos)
    || value.repos.some((repo) => !isRendererRecord(repo) || typeof repo.repoId !== "string" || typeof repo.displayName !== "string" || !["enabled", "disabled"].includes(String(repo.registrationState)) || !["warming", "attached", "unavailable", "not_loaded"].includes(String(repo.cellState)))) throw new Error(localErrorHint(value, "System status bridge returned an invalid result."));
  return value as unknown as SystemStatusSuccess;
}
function readDaemonControlReceipt(value: unknown): DaemonControlReceipt {
  if (!isRendererRecord(value) || value.schema !== "daemon-control-receipt/v1" || typeof value.ok !== "boolean" || !["pending", "op_rejected"].includes(String(value.outcome)) || !["refresh", "restart"].includes(String(value.kind)) || typeof value.operationId !== "string" || !["queued", "draining", "starting", "settled", "failed"].includes(String(value.phase))) throw new Error(localErrorHint(value, "Daemon control bridge returned an invalid receipt."));
  return value as unknown as DaemonControlReceipt;
}
function readCatalogSnapshot(value: unknown): CatalogSnapshotSuccess {
  if (!isRendererRecord(value) || value.schema !== "gui-catalog-snapshot/v1" || value.ok !== true || !["ready", "pending"].includes(String(value.status)) || typeof value.repoId !== "string" || !isRendererRecord(value.defaults) || !Array.isArray(value.presets) || !Array.isArray(value.verticals) || !Array.isArray(value.templates) || !Array.isArray(value.adapters)) throw new Error(localErrorHint(value, "Catalog snapshot bridge returned an invalid result."));
  return value as unknown as CatalogSnapshotSuccess;
}
function readCatalogPreset(value: unknown): CatalogPresetSuccess {
  if (!isRendererRecord(value) || value.schema !== "gui-catalog-preset/v1" || value.ok !== true || typeof value.repoId !== "string" || !isRendererRecord(value.preset) || !isRendererRecord(value.resolved)) throw new Error(localErrorHint(value, "Catalog preset bridge returned an invalid result."));
  return value as unknown as CatalogPresetSuccess;
}
function readCatalogRereadReceipt(value: unknown): CatalogRereadReceipt {
  if (!isRendererRecord(value) || value.schema !== "catalog-reread-receipt/v1" || typeof value.ok !== "boolean" || !["applied", "op_rejected"].includes(String(value.outcome)) || typeof value.operationId !== "string" || typeof value.repoId !== "string") throw new Error(localErrorHint(value, "Catalog reread bridge returned an invalid receipt."));
  return value as unknown as CatalogRereadReceipt;
}

function isTaskSnapshotProjectionRow(value: unknown): value is TaskSnapshotProjectionRow {
  if (!isRendererRecord(value) || typeof value.taskId !== "string" || value.createdAt !== null && typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || value.generation !== "v0" && value.generation !== "v1" || !isRendererRecord(value.snapshot)) return false;
  const task = value.snapshot.task;
  return isRendererRecord(task) && task.schema === "task/v1" && task.taskId === value.taskId && typeof task.title === "string";
}

function isDecisionProjectionRow(value: unknown): value is DecisionProjectionRow {
  return isRendererRecord(value) && value.schema === "decision-row/v1" && typeof value.decisionId === "string" && typeof value.title === "string" && typeof value.state === "string" && Number.isInteger(value.workspaceRevision) && Array.isArray(value.claims);
}

function isRelationGraphEdgeRow(value: unknown): value is RelationGraphEdgeRow {
  return isRendererRecord(value) && typeof value.sourceRef === "string" && typeof value.targetRef === "string"
    && typeof value.relationType === "string";
}

function isRelationCoverageRow(value: unknown): value is RelationCoverageRow {
  return isRendererRecord(value) && typeof value.decisionRef === "string" && typeof value.claimRef === "string" && typeof value.status === "string" && (value.fulfillment === null || ["evidenced", "delivered", "standing-policy"].includes(String(value.fulfillment))) && (value.refutingFactRefs === undefined || Array.isArray(value.refutingFactRefs)) && Array.isArray(value.relationPath) && (value.basisRevision === undefined || Number.isInteger(value.basisRevision));
}

function isFactAnchorRow(value: unknown): value is FactAnchorRow {
  return isRendererRecord(value) && typeof value.factRef === "string" && typeof value.taskId === "string"
    && typeof value.factId === "string";
}

function localErrorHint(value: unknown, fallback: string): string {
  if (isRendererRecord(value) && value.ok === false && isRendererRecord(value.error) && typeof value.error.hint === "string") return value.error.hint;
  return fallback;
}
