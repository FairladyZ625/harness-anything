import type {
  AgendaRead,
  AgendaTaskRow,
  AgendaAwaitingRow,
  ContractVersion,
  DecisionProjectionRow,
  FactAnchorRow,
  RelationFactRow,
  GuiActionResult,
  GuiSubmissionV1,
  ObserveTailPayload,
  ObserveTailRead,
  ProjectionWarning,
  RelationCoverageRow,
  RelationGraphEdgeRow,
  RelationType,
  TaskDocumentListProjectionRead,
  TaskDocumentProjectionRead,
  TaskDispatchesRead,
  TaskSnapshotProjectionRow,
  WorkspaceSummaryRead,
  SettingsRead,
} from "../api/renderer-dto.ts";
import { isRendererRecord } from "./result-validation.ts";
import { invoke } from "./api-client-invoke.ts";

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
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly facts: ReadonlyArray<RelationFactRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
  readonly page?: QueryPage;
}

/**
 * `repo.agenda.read` 的有界一页。四个分组只做透传:分组判定与组内 pin 置顶都在
 * daemon 投影里完成,renderer 不重推任何「在飞/待裁/球在别人手里/可派」判据。
 */
export interface AgendaSuccess
  extends Pick<AgendaRead, "inFlight" | "awaitingDecision" | "waitingOnOthers" | "dispatchable" | "summary"> {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly page: { readonly sourceLimit: number; readonly cursor: string | null; readonly nextCursor: string | null };
  readonly watermark: number;
  readonly sourceRevision: number;
}

export interface QueryPage {
  readonly limit: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}
export type TaskDispatchBatchRead = Extract<TaskDispatchesRead, { readonly taskIds: readonly string[] }>;

/** Optional narrow/paged facets for the wide task reads; omitting them keeps the full result. */
export interface TaskQueryFacets {
  readonly status?: string;
  readonly changedAfterRevision?: number;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
/** Legacy wide read: no facet selector, optionally narrowed by status/time/page. */
export interface RelationPageQuery {
  readonly status?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
/** `repo.triadic.relationGraph` facet read: one row array, every other array empty. */
export interface RelationEdgeFacetQuery {
  readonly facet: "edges";
  readonly relationType?: string;
  readonly state?: "active" | "edge_retired" | "deleted";
  readonly direction?: "directed" | "undirected";
}
export interface RelationFactFacetQuery {
  readonly facet: "facts";
}
/** `repo.triadic.relationGraph {facet:"runtimeEdges"}`:运行时平面(agent→task)派发边。 */
export interface RelationRuntimeEdgeFacetQuery {
  readonly facet: "runtimeEdges";
}
export type RelationQueryFacets =
  | RelationPageQuery
  | RelationEdgeFacetQuery
  | RelationFactFacetQuery
  | RelationRuntimeEdgeFacetQuery;

export interface DecisionListSuccess {
  readonly ok: true;
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

/**
 * `repo.decisions.list {projection:"summary"}` row: identity + scope only. The summary
 * projection exists so always-mounted chrome (⌘K palette, task-detail decision titles)
 * never has to pull `chosen`/`rejected`/`claims`/`judgmentConsents`, which is where the
 * 4.2 MB full decision response spends its bytes.
 */
export interface DecisionSummaryRow {
  readonly decisionId: string;
  readonly title: string;
  readonly state: DecisionProjectionRow["state"];
  readonly appliesTo: { readonly modules: readonly string[]; readonly productLines: readonly string[] };
}
export interface DecisionSummaryListSuccess {
  readonly ok: true;
  readonly projection: "summary";
  readonly decisions: ReadonlyArray<DecisionSummaryRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

/** `repo.triadic.relationGraph {facet:"facts"}` row: the palette's fact vocabulary. */
export interface RelationFactSummaryRow {
  readonly anchor: string;
  readonly text: string;
  readonly category: "lesson" | "finding" | "progress";
  readonly taskId?: string;
}
export interface RelationFactFacetSuccess {
  readonly ok: true;
  readonly facet: "facts";
  readonly facts: ReadonlyArray<RelationFactSummaryRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}
export type WorkspaceSummarySuccess = WorkspaceSummaryRead;
export type SettingsSuccess = SettingsRead;
export type SettingsUpdateInput = RepoScope &
  Partial<{
    defaultVertical: string;
    defaultPreset: string;
    defaultProfile: string;
    locale: "en-US" | "zh-CN";
    taskScaffold: string;
    repositoryScaffold: string;
    walFlushAdaptive: boolean;
    walFlushEvents: number;
    walFlushBytes: number;
    walFlushMilliseconds: number;
  }> & { readonly idempotencyKey: string };

export interface DecisionControlListSuccess {
  readonly status: "ready" | "pending";
  readonly decisionIds: ReadonlyArray<string>;
  readonly opId: string;
  readonly hint?: string;
}

export interface DecisionShowSuccess {
  readonly status: "ready" | "pending";
  readonly decision: DecisionProjectionRow;
  readonly hint: string | null;
}

export interface RepoScope {
  readonly repoId: string;
}
export type ObserveTailRequest = RepoScope & ObserveTailPayload;
export interface SystemRepoRow {
  readonly repoId: string;
  readonly displayName: string;
  readonly canonicalRoot: string;
  readonly authoredBranch: string;
  readonly registrationState: "enabled" | "disabled";
  readonly cellState: "warming" | "attached" | "unavailable" | "not_loaded";
  readonly generation: number | null;
  readonly queueDepth: number | null;
  readonly lockState: "held" | "not_applicable" | "unknown";
  readonly recoveryMs: number | null;
  readonly lastError: string | null;
  readonly unavailableReason: string | null;
}
export interface DaemonPoint {
  readonly daemonId: string;
  readonly pid: number;
  readonly startedAt: string;
}
export interface SystemStatusSuccess {
  readonly schema: "gui-system-status/v1";
  readonly ok: true;
  readonly observedAt: string;
  readonly daemon: DaemonPoint & {
    readonly protocolVersion: ContractVersion;
    readonly uptimeMs: number;
    readonly endpoint: string;
    readonly build: { readonly version: string; readonly commitSha: string | null };
    readonly buildStale?: null | { readonly daemonCommit: string; readonly clientCommit: string };
    readonly userRoot?: string;
    readonly activeControl: null | {
      readonly kind: "refresh" | "restart";
      readonly operationId: string;
      readonly phase: DaemonControlReceipt["phase"];
      readonly requestedAt: string;
      readonly error: BridgeError | null;
    };
  };
  readonly repos: ReadonlyArray<SystemRepoRow>;
}
export interface BridgeError {
  readonly code: string;
  readonly hint: string;
}
export interface DaemonControlReceipt {
  readonly schema: "daemon-control-receipt/v1";
  readonly ok: boolean;
  readonly outcome: "pending" | "op_rejected";
  readonly kind: "refresh" | "restart";
  readonly operationId: string;
  readonly phase: "queued" | "draining" | "starting" | "settled" | "failed";
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly before: DaemonPoint | null;
  readonly after: DaemonPoint | null;
  readonly error: BridgeError | null;
  readonly nextAction: string | null;
}
export interface CatalogPresetRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly verticalId: string;
  readonly sourceKind: "bundled" | "user" | "user-shadow";
  readonly validity: "valid" | "unavailable" | "blocked";
  readonly version: string | null;
  readonly kind: string | null;
  readonly defaultProfile: string | null;
  readonly profiles: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly entrypoints: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<unknown>;
  readonly shadows: { readonly layer: "bundled"; readonly title: string } | null;
}
export interface CatalogVerticalRow {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly source: "builtin";
  readonly available: boolean;
  readonly valid: boolean;
  readonly issues: ReadonlyArray<unknown>;
}
export interface CatalogTemplateRow {
  readonly templateRef: string;
  readonly slot: string;
  readonly materializeAs: string;
  readonly locales: ReadonlyArray<string>;
}
export interface CatalogAdapterRow {
  readonly adapterId: string;
  readonly registered: true;
  readonly capabilities: ReadonlyArray<string>;
  readonly writability: "read-only" | "read-write" | "unknown";
  readonly defaultProvider: boolean;
  readonly unavailableReason: string | null;
}
export interface CatalogSnapshotSuccess {
  readonly schema: "gui-catalog-snapshot/v1";
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly repoId: string;
  readonly observedAt: string;
  readonly catalogDigest: string;
  readonly defaults: {
    readonly verticalId: string;
    readonly presetId: string;
    readonly profileId: string | null;
    readonly locale: string;
  };
  readonly presets: ReadonlyArray<CatalogPresetRow>;
  readonly verticals: ReadonlyArray<CatalogVerticalRow>;
  readonly templates: ReadonlyArray<CatalogTemplateRow>;
  readonly scaffolds: { readonly task: ReadonlyArray<string>; readonly repository: ReadonlyArray<string> };
  readonly adapters: ReadonlyArray<CatalogAdapterRow>;
}
export interface CatalogPresetDocument {
  readonly slot: string;
  readonly path: string;
  readonly body: string;
  readonly mediaType: string;
  readonly owner: string;
  readonly templateRef: string;
}
export interface CatalogPresetSuccess {
  readonly schema: "gui-catalog-preset/v1";
  readonly ok: true;
  readonly repoId: string;
  readonly preset: {
    readonly id: string;
    readonly verticalId: string;
    readonly version: string | null;
    readonly extends: string | null;
    readonly capabilityImports: ReadonlyArray<unknown>;
  };
  readonly resolved: {
    readonly profile: Readonly<Record<string, unknown>>;
    readonly templates: ReadonlyArray<unknown>;
    readonly documents: ReadonlyArray<CatalogPresetDocument>;
    readonly entrypoints: ReadonlyArray<unknown>;
    readonly provenance: Readonly<Record<string, unknown>>;
    readonly digest: string;
  };
}
export interface CatalogRereadReceipt {
  readonly schema: "catalog-reread-receipt/v1";
  readonly ok: boolean;
  readonly outcome: "applied" | "op_rejected";
  readonly operationId: string;
  readonly repoId: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly observedAt: string;
  readonly error: BridgeError | null;
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
  readonly fulfillments: ReadonlyArray<{
    readonly claimId: string;
    readonly mode: "evidenced" | "delivered" | "standing_policy";
  }>;
  readonly relations: ReadonlyArray<{
    readonly anchor: string;
    readonly type: RelationType;
    readonly target: string;
    readonly rationale: string;
  }>;
}

export const harnessClient = {
  async getSystemStatus(): Promise<SystemStatusSuccess> {
    return readSystemStatus(await invoke("daemon.gui.system.read", {}, "getSystemStatus"));
  },
  async requestDaemonControl(payload: {
    readonly kind: "refresh" | "restart";
    readonly authorityRepoId: string;
    readonly reason?: string;
  }): Promise<DaemonControlReceipt> {
    return readDaemonControlReceipt(await invoke("daemon.gui.control.request", payload, "requestDaemonControl"));
  },
  async getDaemonControlReceipt(payload: { readonly operationId: string }): Promise<DaemonControlReceipt> {
    return readDaemonControlReceipt(await invoke("daemon.gui.control.receipt", payload, "getDaemonControlReceipt"));
  },
  async tailObservability(payload: ObserveTailRequest): Promise<ObserveTailRead> {
    return readObserveTailResult(await invoke("observe.tail", payload, "tailObservability"));
  },
  async getTasks(payload: RepoScope & TaskQueryFacets): Promise<TaskListSuccess> {
    return readTaskListResult(await invoke("repo.tasks.list", payload, "getTasks"));
  },
  async getAgenda(payload: RepoScope & { readonly limit?: number; readonly cursor?: string }): Promise<AgendaSuccess> {
    return readAgendaResult(await invoke("repo.agenda.read", payload, "getAgenda"));
  },
  async getSettings(payload: RepoScope): Promise<SettingsSuccess> {
    return readSettingsResult(await invoke("repo.settings.read", payload, "getSettings"));
  },
  async updateSettings(payload: SettingsUpdateInput): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.settings.update", payload, "updateSettings"));
  },
  async getWorkspaceSummary(payload: RepoScope): Promise<WorkspaceSummarySuccess> {
    return readWorkspaceSummaryResult(await invoke("repo.workspace.summary.read", payload, "getWorkspaceSummary"));
  },
  async getTaskDocument(
    payload: RepoScope & { readonly taskId: string; readonly path: string },
  ): Promise<TaskDocumentProjectionRead> {
    return readTaskDocumentResult(await invoke("repo.tasks.document.read", payload, "getTaskDocument"));
  },
  async getTaskDocuments(payload: RepoScope & { readonly taskId: string }): Promise<TaskDocumentListProjectionRead> {
    return readTaskDocumentListResult(await invoke("repo.tasks.documents.list", payload, "getTaskDocuments"));
  },
  async getTaskDispatches(
    payload: RepoScope &
      (
        | { readonly taskId: string }
        | { readonly taskIds: readonly string[]; readonly limit?: number; readonly cursor?: string }
      ),
  ): Promise<TaskDispatchesRead> {
    return readTaskDispatchesResult(await invoke("repo.task.dispatches", payload, "getTaskDispatches"));
  },
  async getRelationGraph(payload: RepoScope & RelationQueryFacets): Promise<RelationGraphSuccess> {
    return readRelationGraphResult(await invoke("repo.triadic.relationGraph", payload, "getRelationGraph"));
  },
  async getRelationFacts(payload: RepoScope & RelationFactFacetQuery): Promise<RelationFactFacetSuccess> {
    return readRelationFactFacetResult(await invoke("repo.triadic.relationGraph", payload, "getRelationGraph"));
  },
  async getDecisions(payload: RepoScope): Promise<DecisionListSuccess> {
    return readDecisionListResult(await invoke("repo.decisions.list", payload, "getDecisions"));
  },
  async getDecisionSummaries(payload: RepoScope): Promise<DecisionSummaryListSuccess> {
    return readDecisionSummaryListResult(
      await invoke("repo.decisions.list", { ...payload, projection: "summary" }, "getDecisions"),
    );
  },
  async listDecisionControls(
    payload: RepoScope & {
      readonly search?: string;
      readonly state?: string;
      readonly module?: string;
      readonly productLine?: string;
    },
  ): Promise<DecisionControlListSuccess> {
    return readDecisionControlList(await invoke("repo.decision.list", payload, "listDecisions"));
  },
  async showDecision(
    payload: RepoScope & { readonly decisionId: string; readonly includeBody?: boolean },
  ): Promise<DecisionShowSuccess> {
    return readDecisionShowResult(await invoke("repo.decision.show", payload, "showDecision"));
  },
  async proposeDecision(payload: RepoScope & DecisionProposalInput): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.propose", payload, "proposeDecision"));
  },
  async acceptDecision(
    payload: RepoScope & {
      readonly decisionId: string;
      readonly rationale: string;
      readonly judgmentOnlyRationale?: string;
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.accept", payload, "acceptDecision"));
  },
  async rejectDecision(
    payload: RepoScope & { readonly decisionId: string; readonly reason: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.reject", payload, "rejectDecision"));
  },
  async deferDecision(
    payload: RepoScope & { readonly decisionId: string; readonly reason: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.defer", payload, "deferDecision"));
  },
  async startTask(
    payload: RepoScope & { readonly taskId: string; readonly executionId: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.start", payload, "startTask"));
  },
  async appendTaskProgress(
    payload: RepoScope & {
      readonly taskId: string;
      readonly executionId?: string;
      readonly text: string;
      readonly evidence?: ReadonlyArray<{ readonly type: string; readonly path: string; readonly summary: string }>;
      readonly baseDocumentSha256?: string | null;
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.progress.append", payload, "appendTaskProgress"));
  },
  async submitTask(
    payload: RepoScope & {
      readonly taskId: string;
      readonly executionId: string;
      readonly submission: GuiSubmissionV1;
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.submit", payload, "submitTask"));
  },
  /** 台账 pin 的唯一 GUI 写通道:daemon 侧就是 `ha task pin` 的 pinned-only amend。 */
  async pinTask(payload: RepoScope & { readonly taskId: string }): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.pin", payload, "pinTask"));
  },
  async unpinTask(payload: RepoScope & { readonly taskId: string }): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.unpin", payload, "unpinTask"));
  },
  async showReceipt(payload: RepoScope & { readonly opId: string }): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.receipt.show", payload, "showReceipt"));
  },
  async getCatalogSnapshot(payload: RepoScope): Promise<CatalogSnapshotSuccess> {
    return readCatalogSnapshot(await invoke("repo.gui.catalog.snapshot", payload, "getCatalogSnapshot"));
  },
  async getCatalogPreset(
    payload: RepoScope & { readonly presetId: string; readonly profileId?: string; readonly locale?: string },
  ): Promise<CatalogPresetSuccess> {
    return readCatalogPreset(await invoke("repo.gui.catalog.preset.read", payload, "getCatalogPreset"));
  },
  async rereadCatalog(payload: RepoScope & { readonly expectedDigest?: string }): Promise<CatalogRereadReceipt> {
    return readCatalogRereadReceipt(await invoke("repo.gui.catalog.reread", payload, "rereadCatalog"));
  },
};

function readTaskDocumentListResult(value: unknown): TaskDocumentListProjectionRead {
  const result = value as Partial<TaskDocumentListProjectionRead>;
  if (
    !result ||
    result.ok !== true ||
    (result.status !== "ready" && result.status !== "pending") ||
    typeof result.taskId !== "string" ||
    !Array.isArray(result.documents) ||
    result.documents.some(
      (doc) =>
        !isRendererRecord(doc) ||
        typeof doc.path !== "string" ||
        typeof doc.blobSha256 !== "string" ||
        !Number.isInteger(doc.size) ||
        typeof doc.mediaType !== "string" ||
        typeof doc.uncommitted !== "boolean",
    ) ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision)
  )
    throw new Error(localErrorHint(value, "Task document list bridge returned an invalid result."));
  return result as TaskDocumentListProjectionRead;
}

function readSettingsResult(value: unknown): SettingsSuccess {
  if (!isSettingsSuccess(value)) throw new Error(localErrorHint(value, "Settings bridge returned an invalid result."));
  return value;
}

function isSettingsSuccess(value: unknown): value is SettingsSuccess {
  if (!isRendererRecord(value) || !isRendererRecord(value.settings)) return false;
  const settings = value.settings;
  return (
    value.schema === "daemon.settings-read/v1" &&
    value.ok === true &&
    settings.schema === "settings/v1" &&
    settings.settingsId === "repository" &&
    [settings.defaultVertical, settings.defaultPreset, settings.defaultProfile].every(
      (field) => typeof field === "string" && field.length > 0,
    ) &&
    ["en-US", "zh-CN"].includes(String(settings.locale)) &&
    isRendererRecord(settings.scaffolds) &&
    [settings.scaffolds.task, settings.scaffolds.repository].every(
      (field) => typeof field === "string" && field.length > 0,
    ) &&
    isRendererRecord(settings.walFlush) &&
    typeof settings.walFlush.adaptive === "boolean" &&
    [settings.walFlush.events, settings.walFlush.bytes, settings.walFlush.milliseconds].every(
      (field) => Number.isSafeInteger(field) && Number(field) > 0,
    )
  );
}

function readTaskDispatchesResult(value: unknown): TaskDispatchesRead {
  const result = value as Partial<TaskDispatchesRead> & {
      readonly taskId?: unknown;
      readonly taskIds?: unknown;
      readonly unavailableTaskIds?: unknown;
      readonly page?: unknown;
    },
    taskIds = Array.isArray(result?.taskIds) ? result.taskIds : [],
    unavailableTaskIds = Array.isArray(result?.unavailableTaskIds) ? result.unavailableTaskIds : [],
    single = typeof result?.taskId === "string",
    batch =
      taskIds.length > 0 &&
      taskIds.every((taskId) => typeof taskId === "string") &&
      unavailableTaskIds.every((taskId) => typeof taskId === "string" && taskIds.includes(taskId)) &&
      isQueryPage(result.page);
  if (
    !result ||
    result.ok !== true ||
    (result.status !== "ready" && result.status !== "pending") ||
    single === batch ||
    !Array.isArray(result.dispatches) ||
    result.dispatches.some(
      (row) =>
        !isRendererRecord(row) ||
        typeof row.dispatchId !== "string" ||
        typeof row.runtimeSessionId !== "string" ||
        !["running", "succeeded", "failed", "unknown", "cancelled", "lost"].includes(String(row.status)),
    ) ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision)
  )
    throw new Error(localErrorHint(value, "Task dispatches bridge returned an invalid result."));
  return result as TaskDispatchesRead;
}

function readTaskDocumentResult(value: unknown): TaskDocumentProjectionRead {
  const result = value as Partial<TaskDocumentProjectionRead>;
  if (
    !result ||
    result.ok !== true ||
    (result.status !== "ready" && result.status !== "pending") ||
    typeof result.taskId !== "string" ||
    typeof result.path !== "string" ||
    typeof result.body !== "string" ||
    (result.worktreeBody !== null && typeof result.worktreeBody !== "string") ||
    typeof result.uncommitted !== "boolean" ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision)
  )
    throw new Error(localErrorHint(value, "Task document bridge returned an invalid result."));
  return result as TaskDocumentProjectionRead;
}

function readTaskListResult(value: unknown): TaskListSuccess {
  const result = value as Partial<TaskListSuccess>;
  if (
    !result ||
    result.ok !== true ||
    !Array.isArray(result.rows) ||
    !result.rows.every(isTaskSnapshotProjectionRow) ||
    (result.status !== "ready" && result.status !== "pending") ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision) ||
    (result.page !== undefined && !isQueryPage(result.page))
  ) {
    throw new Error(localErrorHint(value, "Task list bridge returned an invalid result."));
  }
  return {
    ok: true,
    status: result.status as "ready" | "pending",
    rows: result.rows,
    watermark: result.watermark as number,
    sourceRevision: result.sourceRevision as number,
    warnings: Array.isArray(result.warnings)
      ? result.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    ...(result.page ? { page: result.page } : {}),
  };
}

function readAgendaResult(value: unknown): AgendaSuccess {
  const result = value as Partial<AgendaSuccess>;
  if (
    !result ||
    result.ok !== true ||
    (result.status !== "ready" && result.status !== "pending") ||
    !Array.isArray(result.inFlight) ||
    !result.inFlight.every(isAgendaTaskRow) ||
    !Array.isArray(result.awaitingDecision) ||
    !result.awaitingDecision.every(isAgendaAwaitingRow) ||
    !Array.isArray(result.waitingOnOthers) ||
    !result.waitingOnOthers.every(isAgendaTaskRow) ||
    !Array.isArray(result.dispatchable) ||
    !result.dispatchable.every(isAgendaTaskRow) ||
    typeof result.summary !== "string" ||
    !isRendererRecord(result.page) ||
    !Number.isInteger(result.page.sourceLimit) ||
    (result.page.cursor !== null && typeof result.page.cursor !== "string") ||
    (result.page.nextCursor !== null && typeof result.page.nextCursor !== "string") ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision)
  )
    throw new Error(localErrorHint(value, "Agenda bridge returned an invalid result."));
  return result as AgendaSuccess;
}

/** 分组判据不在 renderer 重建:这里只验形状,分组语义全部来自 daemon 投影。 */
function isAgendaTaskRow(value: unknown): value is AgendaTaskRow {
  return (
    isRendererRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.pinned === "boolean" &&
    typeof value.updatedAt === "string" &&
    (value.leaseExecutionId === null || typeof value.leaseExecutionId === "string") &&
    Array.isArray(value.activeExecutionIds) &&
    value.activeExecutionIds.every((id) => typeof id === "string") &&
    isRendererRecord(value.blockingAssessment)
  );
}

function isAgendaAwaitingRow(value: unknown): value is AgendaAwaitingRow {
  if (!isRendererRecord(value)) return false;
  if (value.kind === "decision")
    return (
      typeof value.decisionId === "string" &&
      typeof value.title === "string" &&
      ["low", "medium", "high"].includes(String(value.riskTier)) &&
      ["low", "medium", "high"].includes(String(value.urgency)) &&
      typeof value.proposedAt === "string"
    );
  return (
    value.kind === "execution" &&
    typeof value.taskId === "string" &&
    typeof value.title === "string" &&
    typeof value.pinned === "boolean" &&
    typeof value.executionId === "string" &&
    typeof value.submittedAt === "string" &&
    isRendererRecord(value.blockingAssessment)
  );
}

function readWorkspaceSummaryResult(value: unknown): WorkspaceSummarySuccess {
  const result = value as Partial<WorkspaceSummarySuccess>;
  if (
    !result ||
    result.schema !== "daemon.workspace-summary/v1" ||
    result.ok !== true ||
    (result.status !== "ready" && result.status !== "pending") ||
    !isRendererRecord(result.tasks) ||
    !Number.isInteger(result.tasks.total) ||
    !isRendererRecord(result.tasks.byStatus) ||
    !isRendererRecord(result.decisions) ||
    !Number.isInteger(result.decisions.total) ||
    !Number.isInteger(result.decisions.inboxCount) ||
    !isRendererRecord(result.decisions.byState) ||
    !Array.isArray(result.decisions.groups) ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision)
  ) {
    throw new Error(localErrorHint(value, "Workspace summary bridge returned an invalid result."));
  }
  return result as WorkspaceSummarySuccess;
}

function readObserveTailResult(value: unknown): ObserveTailRead {
  const result = value as Partial<ObserveTailRead>;
  if (
    !result ||
    result.schema !== "daemon.observe-tail/v3" ||
    result.ok !== true ||
    typeof result.repoId !== "string" ||
    !["local", "remote-center", "remote-edge"].includes(String(result.mode)) ||
    !["events", "repo-log", "daemon-log", "dispatch"].includes(String(result.kind)) ||
    !["history", "follow"].includes(String(result.direction)) ||
    !["ready", "pending", "unavailable", "gap"].includes(String(result.status)) ||
    !Array.isArray(result.items) ||
    !(result.historyCursor === null || isRendererRecord(result.historyCursor)) ||
    !(result.liveCursor === null || isRendererRecord(result.liveCursor)) ||
    !(result.sourceCursor === null || isRendererRecord(result.sourceCursor)) ||
    typeof result.done !== "boolean"
  )
    throw new Error(localErrorHint(value, "Observability tail bridge returned an invalid result."));
  return result as ObserveTailRead;
}

function readRelationGraphResult(value: unknown): RelationGraphSuccess {
  const result = value as Partial<RelationGraphSuccess>;
  if (
    !result ||
    result.ok !== true ||
    !Array.isArray(result.edges) ||
    !Array.isArray(result.coverageRows) ||
    !Array.isArray(result.factAnchors) ||
    !Array.isArray(result.facts) ||
    (result.page !== undefined && !isQueryPage(result.page))
  ) {
    throw new Error(localErrorHint(value, "Relation graph bridge returned an invalid result."));
  }
  return {
    ok: true,
    edges: result.edges.filter(isRelationGraphEdgeRow),
    coverageRows: result.coverageRows.filter(isRelationCoverageRow),
    factAnchors: result.factAnchors.filter(isFactAnchorRow),
    facts: result.facts,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    ...(result.page ? { page: result.page } : {}),
  };
}

function isQueryPage(value: unknown): value is QueryPage {
  return (
    isRendererRecord(value) &&
    typeof value.limit === "number" &&
    Number.isSafeInteger(value.limit) &&
    value.limit >= 1 &&
    value.limit <= 500 &&
    (value.cursor === null || typeof value.cursor === "string") &&
    (value.nextCursor === null || typeof value.nextCursor === "string")
  );
}

function readDecisionListResult(value: unknown): DecisionListSuccess {
  const result = value as Partial<DecisionListSuccess>;
  if (!result || result.ok !== true || !Array.isArray(result.decisions)) {
    throw new Error(localErrorHint(value, "Decision list bridge returned an invalid result."));
  }
  return {
    ok: true,
    decisions: result.decisions.filter(isDecisionProjectionRow),
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

/** Summary rows are a different wire shape than `decision-row/v1`; never filter them
 *  through `isDecisionProjectionRow`, which would silently drop every row. */
function readDecisionSummaryListResult(value: unknown): DecisionSummaryListSuccess {
  const result = value as Partial<DecisionSummaryListSuccess>;
  const rows = result?.decisions;
  if (
    !result ||
    result.ok !== true ||
    result.projection !== "summary" ||
    !Array.isArray(rows) ||
    !rows.every(isDecisionSummaryRow)
  ) {
    throw new Error(localErrorHint(value, "Decision summary bridge returned an invalid result."));
  }
  return {
    ok: true,
    projection: "summary",
    decisions: rows,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

function isDecisionSummaryRow(value: unknown): value is DecisionSummaryRow {
  if (!isRendererRecord(value)) return false;
  const appliesTo = value.appliesTo;
  return (
    typeof value.decisionId === "string" &&
    typeof value.title === "string" &&
    typeof value.state === "string" &&
    isRendererRecord(appliesTo) &&
    Array.isArray(appliesTo.modules) &&
    Array.isArray(appliesTo.productLines)
  );
}

function readRelationFactFacetResult(value: unknown): RelationFactFacetSuccess {
  const result = value as Partial<RelationFactFacetSuccess>;
  if (
    !result ||
    result.ok !== true ||
    result.facet !== "facts" ||
    !Array.isArray(result.facts) ||
    !result.facts.every(isRelationFactSummaryRow)
  ) {
    throw new Error(localErrorHint(value, "Relation fact facet bridge returned an invalid result."));
  }
  return {
    ok: true,
    facet: "facts",
    facts: result.facts,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

function isRelationFactSummaryRow(value: unknown): value is RelationFactSummaryRow {
  if (!isRendererRecord(value)) return false;
  return (
    typeof value.anchor === "string" &&
    typeof value.text === "string" &&
    (value.category === "lesson" || value.category === "finding" || value.category === "progress") &&
    (value.taskId === undefined || typeof value.taskId === "string")
  );
}

function readGuiActionResult(value: unknown): GuiActionResult {
  const result = value as Partial<GuiActionResult>;
  if (
    !result ||
    result.schema !== "command-receipt/v2" ||
    typeof result.ok !== "boolean" ||
    typeof result.command !== "string" ||
    !["applied", "pending", "no_changes", "indeterminate", "op_rejected"].includes(String(result.outcome)) ||
    typeof result.opId !== "string"
  ) {
    throw new Error(localErrorHint(value, "GUI action bridge returned an invalid receipt."));
  }
  return result as GuiActionResult;
}

function readDecisionControlList(value: unknown): DecisionControlListSuccess {
  const receipt = readGuiActionResult(value) as GuiActionResult & {
    readonly evidence?: string;
    readonly nextAction?: string;
    readonly error?: { readonly code?: string; readonly hint?: string };
  };
  if (receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate")
    throw new Error(
      `${receipt.error?.code ?? receipt.outcome}: ${receipt.error?.hint ?? receipt.nextAction ?? "Decision list failed."}`,
    );
  try {
    const evidence = JSON.parse(receipt.evidence ?? "") as { readonly status?: unknown; readonly decisions?: unknown };
    if ((evidence.status !== "ready" && evidence.status !== "pending") || !Array.isArray(evidence.decisions))
      throw new Error();
    const decisionIds = evidence.decisions.flatMap((item) =>
      isRendererRecord(item) && typeof item.decisionId === "string" ? [item.decisionId] : [],
    );
    return {
      status: evidence.status,
      decisionIds,
      opId: receipt.opId,
      ...(receipt.nextAction ? { hint: receipt.nextAction } : {}),
    };
  } catch {
    throw new Error("Decision list receipt evidence is invalid.");
  }
}

function readDecisionShowResult(value: unknown): DecisionShowSuccess {
  const receipt = readGuiActionResult(value) as GuiActionResult & {
    readonly evidence?: string;
    readonly nextAction?: string;
    readonly error?: { readonly code?: string; readonly hint?: string };
  };
  if (receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate") {
    const detail = receipt.error?.hint ?? receipt.nextAction ?? "Decision show failed.";
    throw new Error(`${receipt.error?.code ?? receipt.outcome}: ${detail}`);
  }
  try {
    const evidence = JSON.parse(receipt.evidence ?? "") as { readonly status?: unknown; readonly decision?: unknown };
    if ((evidence.status !== "ready" && evidence.status !== "pending") || !isDecisionProjectionRow(evidence.decision))
      throw new Error();
    return { status: evidence.status, decision: evidence.decision, hint: receipt.nextAction ?? null };
  } catch {
    throw new Error("Decision show receipt evidence is invalid.");
  }
}

function readSystemStatus(value: unknown): SystemStatusSuccess {
  if (!isSystemStatusSuccess(value))
    throw new Error(localErrorHint(value, "System status bridge returned an invalid result."));
  return value;
}
function readDaemonControlReceipt(value: unknown): DaemonControlReceipt {
  if (!isDaemonControlReceipt(value))
    throw new Error(localErrorHint(value, "Daemon control bridge returned an invalid receipt."));
  return value;
}
function readCatalogSnapshot(value: unknown): CatalogSnapshotSuccess {
  if (!isCatalogSnapshotSuccess(value))
    throw new Error(localErrorHint(value, "Catalog snapshot bridge returned an invalid result."));
  return value;
}
function readCatalogPreset(value: unknown): CatalogPresetSuccess {
  if (!isCatalogPresetSuccess(value))
    throw new Error(localErrorHint(value, "Catalog preset bridge returned an invalid result."));
  return value;
}
function readCatalogRereadReceipt(value: unknown): CatalogRereadReceipt {
  if (!isCatalogRereadReceipt(value))
    throw new Error(localErrorHint(value, "Catalog reread bridge returned an invalid receipt."));
  return value;
}

function isSystemStatusSuccess(value: unknown): value is SystemStatusSuccess {
  return (
    isRendererRecord(value) &&
    value.schema === "gui-system-status/v1" &&
    value.ok === true &&
    typeof value.observedAt === "string" &&
    isRendererRecord(value.daemon) &&
    Array.isArray(value.repos) &&
    value.repos.every(
      (repo) =>
        isRendererRecord(repo) &&
        typeof repo.repoId === "string" &&
        typeof repo.displayName === "string" &&
        ["enabled", "disabled"].includes(String(repo.registrationState)) &&
        ["warming", "attached", "unavailable", "not_loaded"].includes(String(repo.cellState)),
    )
  );
}
function isDaemonControlReceipt(value: unknown): value is DaemonControlReceipt {
  return (
    isRendererRecord(value) &&
    value.schema === "daemon-control-receipt/v1" &&
    typeof value.ok === "boolean" &&
    ["pending", "op_rejected"].includes(String(value.outcome)) &&
    ["refresh", "restart"].includes(String(value.kind)) &&
    typeof value.operationId === "string" &&
    ["queued", "draining", "starting", "settled", "failed"].includes(String(value.phase))
  );
}
function isCatalogSnapshotSuccess(value: unknown): value is CatalogSnapshotSuccess {
  return (
    isRendererRecord(value) &&
    value.schema === "gui-catalog-snapshot/v1" &&
    value.ok === true &&
    ["ready", "pending"].includes(String(value.status)) &&
    typeof value.repoId === "string" &&
    isRendererRecord(value.defaults) &&
    Array.isArray(value.presets) &&
    Array.isArray(value.verticals) &&
    Array.isArray(value.templates) &&
    Array.isArray(value.adapters) &&
    isRendererRecord(value.scaffolds) &&
    Array.isArray(value.scaffolds.task) &&
    Array.isArray(value.scaffolds.repository) &&
    value.presets.every(
      (row) =>
        isRendererRecord(row) &&
        Array.isArray(row.profiles) &&
        row.profiles.every(
          (profile) => isRendererRecord(profile) && typeof profile.id === "string" && typeof profile.title === "string",
        ),
    )
  );
}
function isCatalogPresetSuccess(value: unknown): value is CatalogPresetSuccess {
  return (
    isRendererRecord(value) &&
    value.schema === "gui-catalog-preset/v1" &&
    value.ok === true &&
    typeof value.repoId === "string" &&
    isRendererRecord(value.preset) &&
    isRendererRecord(value.resolved) &&
    Array.isArray(value.resolved.documents) &&
    value.resolved.documents.every(
      (row) =>
        isRendererRecord(row) &&
        typeof row.slot === "string" &&
        typeof row.path === "string" &&
        typeof row.body === "string" &&
        typeof row.mediaType === "string",
    )
  );
}
function isCatalogRereadReceipt(value: unknown): value is CatalogRereadReceipt {
  return (
    isRendererRecord(value) &&
    value.schema === "catalog-reread-receipt/v1" &&
    typeof value.ok === "boolean" &&
    ["applied", "op_rejected"].includes(String(value.outcome)) &&
    typeof value.operationId === "string" &&
    typeof value.repoId === "string"
  );
}

function isTaskSnapshotProjectionRow(value: unknown): value is TaskSnapshotProjectionRow {
  if (
    !isRendererRecord(value) ||
    typeof value.taskId !== "string" ||
    (value.createdAt !== null && typeof value.createdAt !== "string") ||
    typeof value.updatedAt !== "string" ||
    (value.generation !== "v0" && value.generation !== "v1") ||
    !isRendererRecord(value.snapshot)
  )
    return false;
  const task = value.snapshot.task;
  return (
    isRendererRecord(task) &&
    task.schema === "task/v2" &&
    task.taskId === value.taskId &&
    typeof task.title === "string"
  );
}

function isDecisionProjectionRow(value: unknown): value is DecisionProjectionRow {
  return (
    isRendererRecord(value) &&
    value.schema === "decision-row/v1" &&
    typeof value.decisionId === "string" &&
    typeof value.title === "string" &&
    typeof value.state === "string" &&
    Number.isInteger(value.workspaceRevision) &&
    Array.isArray(value.claims)
  );
}

function isRelationGraphEdgeRow(value: unknown): value is RelationGraphEdgeRow {
  return (
    isRendererRecord(value) &&
    typeof value.sourceRef === "string" &&
    typeof value.targetRef === "string" &&
    typeof value.relationType === "string"
  );
}

function isRelationCoverageRow(value: unknown): value is RelationCoverageRow {
  return (
    isRendererRecord(value) &&
    typeof value.decisionRef === "string" &&
    typeof value.claimRef === "string" &&
    typeof value.status === "string" &&
    (value.fulfillment === null || ["evidenced", "delivered", "standing-policy"].includes(String(value.fulfillment))) &&
    (value.refutingFactRefs === undefined || Array.isArray(value.refutingFactRefs)) &&
    Array.isArray(value.relationPath) &&
    (value.basisRevision === undefined || Number.isInteger(value.basisRevision)) &&
    (value.freshnessReason === undefined ||
      ["refuted", "no-live-evidence", "fulfillment-undeclared"].includes(String(value.freshnessReason)))
  );
}

function isFactAnchorRow(value: unknown): value is FactAnchorRow {
  return (
    isRendererRecord(value) &&
    typeof value.factRef === "string" &&
    typeof value.taskId === "string" &&
    typeof value.factId === "string"
  );
}

function localErrorHint(value: unknown, fallback: string): string {
  if (
    isRendererRecord(value) &&
    value.ok === false &&
    isRendererRecord(value.error) &&
    typeof value.error.hint === "string"
  )
    return value.error.hint;
  return fallback;
}
