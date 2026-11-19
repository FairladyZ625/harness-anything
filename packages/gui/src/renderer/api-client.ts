import { readAgendaResult } from "./api-client-agenda.ts";
import type * as DomainStatus from "../api/renderer-dto.ts";
import { daemonControlPhaseWords } from "../api/renderer-dto.ts";
import { repoCellStateWords } from "../api/renderer-dto.ts";
import { repoRegistrationStateWords } from "../api/renderer-dto.ts";

import type {
  DaemonGuiReadPayloadMap,
  DaemonHomeOverviewResult,
  DaemonTaskDispatchesPayload,
} from "@harness-anything/daemon/protocol";
import type { TaskAssignmentDirectory } from "@harness-anything/daemon/protocol";
import type { RepositoryReadFrame } from "@harness-anything/daemon/protocol";
import { repositoryReadFrame } from "./repository-read-frame.ts";
import { validateDaemonTaskCompletion, validateDaemonWorkTopology } from "@harness-anything/daemon/protocol";
import type {
  AgendaRead,
  ContractVersion,
  FactAnchorRow,
  RelationFactRow,
  GuiActionResult,
  ObserveTailPayload,
  ObserveTailRead,
  ProjectionWarning,
  RelationCoverageRow,
  ServedRelationEdgeRow,
  RelationDirection,
  RelationState,
  TaskDocumentListProjectionRead,
  TaskDocumentProjectionRead,
  TaskDispatchesRead,
  TaskSnapshotProjectionRow,
  TaskSnapshotInvalidRow,
  TaskWipRead,
  WorkIndexRead,
  WorkTopologyRead,
  WorkBriefsRead,
  TaskCompletionRead,
  TaskDeliveryDiffRead,
  WorkspaceSummaryRead,
  WorkspaceScopeRead,
  SettingsRead,
} from "../api/renderer-dto.ts";
import type { DecisionState } from "./model/types.ts";
import {
  isFactDomainTypeSummaryRow,
  isRendererRecord,
  isTaskDocumentRead,
  localErrorHint,
  type FactDomainTypeSummaryRow,
} from "./result-validation.ts";
import { isSettingsSuccess } from "./settings-payload.ts";
import type { SettingsFieldValue } from "./settings-form.ts";
import { invoke } from "./api-client-invoke.ts";
import { readGuiActionResult } from "./command-receipt.ts";
import { daemonBridgeError } from "./daemon-startup.ts";
import { readTaskDeliveryDiffResult } from "./api-client-task-delivery-diff.ts";
import { readTaskDocumentListResult } from "./api-client-task-documents.ts";
import { readCatalogPreset, readCatalogRereadReceipt, readCatalogSnapshot } from "./api-client-catalog.ts";
import {
  readDecisionControlList,
  readDecisionListResult,
  readDecisionShowResult,
  readDecisionSummaryListResult,
  type DecisionControlListSuccess,
  type DecisionListSuccess,
  type DecisionProposalInput,
  type DecisionShowSuccess,
  type DecisionSummaryListSuccess,
} from "./api-client-decisions.ts";
export type {
  DecisionControlListSuccess,
  DecisionListSuccess,
  DecisionProposalInput,
  DecisionShowSuccess,
  DecisionSummaryListSuccess,
  DecisionSummaryRow,
} from "./api-client-decisions.ts";

export interface TaskListSuccess extends Partial<RepositoryReadFrame> {
  readonly ok: true;
  readonly status: DomainStatus.ReadSetProjectionCut["status"];
  readonly rows: ReadonlyArray<TaskSnapshotProjectionRow>;
  readonly invalidRows: ReadonlyArray<TaskSnapshotInvalidRow>;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: ReadonlyArray<string>;
  readonly page?: QueryPage;
}

export type TaskCreateGuiReceipt =
  | (GuiActionResult & { readonly ok: true; readonly taskId: string; readonly packagePath: string })
  | (GuiActionResult & { readonly ok: false });

export interface RelationGraphSuccess {
  readonly ok: true;
  readonly edges: ReadonlyArray<ServedRelationEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly facts: ReadonlyArray<RelationFactRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
  readonly page?: QueryPage;
}

/**
 * `repo.agenda.read` 的有界一页。全部分组只做透传:分组判定与组内 pin 置顶都在
 * daemon 投影里完成,renderer 不重推任何「等你答复/在飞/待派审/评审中/待裁/等我修/
 * 球在别人手里/可派」判据。
 */
export interface AgendaSuccess
  extends Pick<
    AgendaRead,
    | "pinnedEntities"
    | "pinnedEntityOverflow"
    | "awaitingYou"
    | "answeredForYou"
    | "attentionItems"
    | "regionWeights"
    | "inFlight"
    | "stalled"
    | "awaitingRestart"
    | "awaitingRework"
    | "awaitingAdjudication"
    | "underReview"
    | "decisionReviewInProgress"
    | "awaitingDecisionReview"
    | "awaitingDecision"
    | "awaitingRuling"
    | "waitingOnOthers"
    | "dispatchable"
    | "summary"
  > {
  readonly ok: true;
  readonly status: DomainStatus.ReadSetProjectionCut["status"];
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
/** The member page of repo.task.dispatches: an agent's or squad's newest dispatch rows. */
export type TaskDispatchMemberRead = Extract<TaskDispatchesRead, { readonly truncated: boolean }>;

/** Optional narrow/paged facets for the wide task reads; omitting them keeps the full result. */
export type TaskQueryFacets = DaemonGuiReadPayloadMap["repo.tasks.list"];
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
  readonly limit?: number;
  readonly cursor?: string;
  readonly facet: "edges";
  readonly relationType?: string;
  readonly state?: RelationState;
  readonly direction?: RelationDirection;
}
/**
 * One indexed page incident to one entity (and its sub-refs, e.g. a decision's claims).
 * No `hops`: the neighborhood depth budget is a different selector and belongs to slice B.
 */
export interface RelationEntityPageQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly entity: string;
  readonly status?: RelationState;
}
export interface RelationFactFacetQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly facet: "facts";
}
/** `repo.triadic.relationGraph {facet:"runtimeEdges"}`:运行时平面(agent→task)派发边。 */
export type RelationRuntimeEdgeFacetQuery = { readonly facet: "runtimeEdges" };
export type RelationQueryFacets =
  | RelationPageQuery
  | RelationEntityPageQuery
  | RelationEdgeFacetQuery
  | RelationFactFacetQuery
  | RelationRuntimeEdgeFacetQuery;

/** `repo.triadic.relationGraph {facet:"facts"}` row: the palette's fact vocabulary. */
export interface RelationFactSummaryRow {
  readonly anchor: string;
  readonly text: string;
  readonly category: "lesson" | "finding" | "progress";
  readonly taskId?: string;
  /** `fact_archived` 投影态(dec_62CAE6CA);缺省 = 未归档(旧 daemon 行)。 */
  readonly archived?: boolean;
}
export interface RelationFactFacetSuccess {
  readonly page: QueryPage;
  readonly ok: true;
  readonly facet: "facts";
  readonly facts: ReadonlyArray<RelationFactSummaryRow>;
  readonly domainTypes: ReadonlyArray<FactDomainTypeSummaryRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}
export type WorkspaceSummarySuccess = WorkspaceSummaryRead;
export type SettingsSuccess = SettingsRead;
/** 键 = settings 动作契约字段名,值形状由 daemon 协议 shape 校验;不做 GUI 侧手写字段清单。 */
export type SettingsUpdateInput = RepoScope &
  Readonly<Record<string, SettingsFieldValue | undefined>> & {
    readonly idempotencyKey: string;
  };

export type RepoScope = { readonly repoId: string };
export type ObserveTailRequest = RepoScope & ObserveTailPayload;
export interface SystemRepoRow {
  readonly repoId: string;
  readonly displayName: string;
  /** remote-proxy 仓本机无工作区,daemon 投影为 null;视图按 mode 解释,不伪造路径。 */
  readonly canonicalRoot: string | null;
  readonly authoredBranch: string | null;
  readonly registrationState: DomainStatus.RepoRegistrationState;
  /** registry v2 的模式(PLT-EdgeGUI);invalid 行回落 "local",与 daemon 投影口径一致。 */
  readonly mode: "local" | "remote-proxy" | "remote-center" | "remote-edge";
  /** 该仓挂在哪个连接下("local" 为隐含本机连接)。 */
  readonly connectionId: string;
  readonly cellState: DomainStatus.RepoCellState;
  readonly generation: number | null;
  readonly queueDepth: number | null;
  readonly lockState: DomainStatus.RepoLockState;
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
    readonly userRoot?: string;
    readonly activeControl: null | {
      readonly kind: "refresh" | "restart";
      readonly operationId: string;
      readonly phase: DaemonControlReceipt["phase"];
      readonly requestedAt: string;
      readonly error: BridgeError | null;
    };
  };
  /** Main-process overlay: the running bundle's own dist/build-id.txt commit. */
  readonly guiBuild?: { readonly commit: string | null };
  readonly repos: ReadonlyArray<SystemRepoRow>;
  readonly nodeAutoClaim?: {
    readonly enabled: boolean;
    readonly configuration: string;
    readonly maxConcurrent: number;
    readonly allowedAgentIds: readonly string[];
    readonly recent: readonly {
      readonly repoId: string;
      readonly taskId: string | null;
      readonly reason: string;
      readonly observedAt: string;
      readonly assignedByPersonId?: string;
      readonly agentId?: string;
    }[];
  };
}
export interface BridgeError {
  readonly code: string;
  readonly hint: string;
}
export interface DaemonControlReceipt {
  readonly schema: "daemon-control-receipt/v1";
  readonly ok: boolean;
  readonly outcome: Extract<DomainStatus.WriteReceiptOutcome, "pending" | "op_rejected">;
  readonly kind: "refresh" | "restart";
  readonly operationId: string;
  readonly phase: DomainStatus.DaemonControlPhase;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly before: DaemonPoint | null;
  readonly after: DaemonPoint | null;
  readonly error: BridgeError | null;
  readonly nextAction: string | null;
}
import type { CatalogPresetSuccess, CatalogRereadReceipt, CatalogSnapshotSuccess } from "./api-client-catalog.ts";
export type {
  CatalogPresetDocument,
  CatalogPresetRow,
  CatalogPresetSuccess,
  CatalogRereadReceipt,
  CatalogSnapshotSuccess,
  CatalogTemplateRow,
  CatalogVerticalRow,
} from "./api-client-catalog.ts";

export const harnessClient = {
  async getHomeOverview(): Promise<DaemonHomeOverviewResult> {
    return (await invoke("daemon.gui.home.read", {})) as DaemonHomeOverviewResult;
  },
  async getSystemStatus(): Promise<SystemStatusSuccess> {
    return readSystemStatus(await invoke("daemon.gui.system.read", {}));
  },
  async requestDaemonControl(payload: {
    readonly kind: "refresh" | "restart";
    readonly authorityRepoId: string;
    readonly reason?: string;
  }): Promise<DaemonControlReceipt> {
    return readDaemonControlReceipt(await invoke("daemon.gui.control.request", payload));
  },
  async getDaemonControlReceipt(payload: { readonly operationId: string }): Promise<DaemonControlReceipt> {
    return readDaemonControlReceipt(await invoke("daemon.gui.control.receipt", payload));
  },
  async tailObservability(payload: ObserveTailRequest): Promise<ObserveTailRead> {
    return readObserveTailResult(await invoke("observe.tail", payload));
  },
  async getTaskAssignmentDirectory(payload: RepoScope & { readonly taskId: string }): Promise<TaskAssignmentDirectory> {
    const result = await invoke("repo.tasks.assignmentDirectory", payload);
    if (result.schema !== "task-assignment-directory/v1")
      throw new Error(localErrorHint(result, "Task assignment directory unavailable."));
    return result;
  },
  async getTasks(payload: RepoScope & TaskQueryFacets): Promise<TaskListSuccess> {
    return readTaskListResult(await invoke("repo.tasks.list", payload));
  },
  /** `repo.task.create` shares the CLI task-create Action and center-forward write receipt. */
  async archiveTasks(
    payload: RepoScope & { readonly taskIds: readonly string[]; readonly reason: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.archive", payload));
  },
  async dismissRuntimeIncident(
    payload: RepoScope & { readonly dispatchId: string; readonly reason: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.agentRuntime.incidentDismiss", payload));
  },
  async resolveTaskEscalation(
    payload: RepoScope & { readonly taskId: string; readonly dispatchId: string; readonly answer: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.escalationResolve", payload));
  },
  async createTask(
    payload: RepoScope & {
      readonly title: string;
      readonly presetId: string;
      readonly verticalId: string;
      readonly locale: string;
      readonly riskTier: string;
      readonly taskClass: string;
      readonly workKind: string;
      readonly parentTaskId?: string;
      readonly idempotencyKey: string;
      readonly plan: string;
    },
  ): Promise<TaskCreateGuiReceipt> {
    const result = readGuiActionResult(await invoke("repo.task.create", payload));
    if (result.ok && (typeof result.taskId !== "string" || typeof result.packagePath !== "string"))
      throw new Error("Task create receipt omitted taskId or packagePath.");
    return result as TaskCreateGuiReceipt;
  },
  async getTaskWip(payload: RepoScope): Promise<TaskWipRead> {
    return readTaskWipResult(await invoke("repo.tasks.wip", payload));
  },
  async getWorkIndex(payload: RepoScope & DaemonGuiReadPayloadMap["repo.works.index"]): Promise<WorkIndexRead> {
    const result = await invoke("repo.works.index", payload);
    if (!result || result.schema !== "daemon.work-index/v1" || result.ok !== true || !Array.isArray(result.works))
      throw new Error(localErrorHint(result, "Work index bridge returned an invalid result."));
    return result;
  },
  async getWorkTopology(payload: RepoScope & { readonly workRootTaskId: string }): Promise<WorkTopologyRead> {
    const result = await invoke("repo.work.topology.read", payload);
    if (validateDaemonWorkTopology(result).length)
      throw new Error(localErrorHint(result, "Work topology bridge returned an invalid result."));
    return result as WorkTopologyRead;
  },
  /** `repo.works.briefs.read`:每工作根的状态桶、分句与抽屉行,daemon 侧唯一推导。 */
  async getWorkBriefs(payload: RepoScope & DaemonGuiReadPayloadMap["repo.works.briefs.read"]): Promise<WorkBriefsRead> {
    const result = await invoke("repo.works.briefs.read", payload);
    if (!result || result.schema !== "daemon.work-briefs/v1" || result.ok !== true || !Array.isArray(result.briefs))
      throw new Error(localErrorHint(result, "Work briefs bridge returned an invalid result."));
    return result;
  },
  async getAgenda(payload: RepoScope & DaemonGuiReadPayloadMap["repo.agenda.read"]): Promise<AgendaSuccess> {
    return readAgendaResult(await invoke("repo.agenda.read", payload));
  },
  async getSettings(payload: RepoScope): Promise<SettingsSuccess> {
    return readSettingsResult(await invoke("repo.settings.read", payload));
  },
  async updateSettings(payload: SettingsUpdateInput): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.settings.update", payload));
  },
  async getWorkspaceSummary(payload: RepoScope): Promise<WorkspaceSummarySuccess> {
    return readWorkspaceSummaryResult(await invoke("repo.workspace.summary.read", payload));
  },
  async getWorkspaceScope(
    payload: RepoScope & DaemonGuiReadPayloadMap["repo.workspace.scope.read"],
  ): Promise<WorkspaceScopeRead> {
    const result = await invoke("repo.workspace.scope.read", payload);
    if (!result || result.schema !== "daemon.workspace-scope/v1" || result.ok !== true)
      throw new Error(localErrorHint(result, "Workspace scope bridge returned an invalid result."));
    return result;
  },
  async getTaskDocument(
    payload: RepoScope & { readonly taskId: string; readonly path: string },
  ): Promise<TaskDocumentProjectionRead> {
    return readTaskDocumentResult(await invoke("repo.tasks.document.read", payload));
  },
  async getTaskCompletion(payload: RepoScope & { readonly taskId: string }): Promise<TaskCompletionRead> {
    const result = await invoke("repo.tasks.completion.read", payload);
    if (validateDaemonTaskCompletion(result).length)
      throw new Error(localErrorHint(result, "Task completion bridge returned an invalid result."));
    return result as TaskCompletionRead;
  },
  async getTaskDocuments(payload: RepoScope & { readonly taskId: string }): Promise<TaskDocumentListProjectionRead> {
    return readTaskDocumentListResult(await invoke("repo.tasks.documents.list", payload));
  },
  async getTaskDeliveryDiff(payload: RepoScope & { readonly taskId: string }): Promise<TaskDeliveryDiffRead> {
    return readTaskDeliveryDiffResult(await invoke("repo.tasks.deliveryDiff.read", payload));
  },
  async getTaskDispatches(payload: RepoScope & DaemonTaskDispatchesPayload): Promise<TaskDispatchesRead> {
    return readTaskDispatchesResult(
      await invoke("repo.task.dispatches", { ...payload, advisorySurface: payload.advisorySurface ?? "gui.dispatch" }),
    );
  },
  async getRelationGraph(payload: RepoScope & RelationQueryFacets): Promise<RelationGraphSuccess> {
    return readRelationGraphResult(await invoke("repo.triadic.relationGraph", payload));
  },
  async getRelationFacts(payload: RepoScope & RelationFactFacetQuery): Promise<RelationFactFacetSuccess> {
    return readRelationFactFacetResult(await invoke("repo.triadic.relationGraph", payload));
  },
  async getDecisions(
    payload: RepoScope &
      Omit<DaemonGuiReadPayloadMap["repo.decisions.list"], "projection"> & {
        readonly state?: Exclude<DecisionState, "unknown">;
      },
  ): Promise<DecisionListSuccess> {
    return readDecisionListResult(await invoke("repo.decisions.list", payload));
  },
  async getDecisionSummaries(payload: RepoScope): Promise<DecisionSummaryListSuccess> {
    return readDecisionSummaryListResult(await invoke("repo.decisions.list", { ...payload, projection: "summary" }));
  },
  async listDecisionControls(
    payload: RepoScope & {
      readonly search?: string;
      readonly state?: string;
      readonly module?: string;
      readonly productLine?: string;
    },
  ): Promise<DecisionControlListSuccess> {
    return readDecisionControlList(await invoke("repo.decision.list", payload));
  },
  async showDecision(
    payload: RepoScope & { readonly decisionId: string; readonly includeBody?: boolean },
  ): Promise<DecisionShowSuccess> {
    return readDecisionShowResult(await invoke("repo.decision.show", payload));
  },
  async proposeDecision(payload: RepoScope & DecisionProposalInput): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.propose", payload));
  },
  async acceptDecision(
    payload: RepoScope & {
      readonly decisionId: string;
      readonly rationale: string;
      readonly judgmentOnlyRationale?: string;
      readonly expectedDigest?: string;
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.accept", payload));
  },
  /** 提案人逐条回应评审意见:与 `ha decision respond-review` 同一动作;回应不解除打回。 */
  async respondDecisionReview(
    payload: RepoScope & {
      readonly decisionId: string;
      readonly responses: ReadonlyArray<{
        readonly reviewId: string;
        readonly findingId: string;
        readonly disposition: DomainStatus.ReviewResponseDisposition;
        readonly rationale: string;
        readonly amendmentRef: string | null;
      }>;
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.respondReview", payload));
  },
  /** 业主具名处置当前切面的打回:与 `ha decision override-review` 同一动作,裁决资格由中心判定。 */
  async overrideDecisionReview(
    payload: RepoScope & {
      readonly decisionId: string;
      readonly reviewContentDigest: string;
      readonly reviewIds: ReadonlyArray<string>;
      readonly reason: string;
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.overrideReview", payload));
  },
  /** 为当前内容切面派一次只读独立评审:同切面重复点击由中心返回既有派工。 */
  async dispatchDecisionReview(
    payload: RepoScope & { readonly decisionId: string; readonly expectedDigest: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.dispatchReview", payload));
  },
  /** 中心文档正文(`ha doc show` 同一读):评审报告按 reportRef 读取,不读本机同名文件。 */
  async showDocument(payload: RepoScope & { readonly path: string }): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.doc.show", payload));
  },
  async rejectDecision(
    payload: RepoScope & { readonly decisionId: string; readonly reason: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.reject", payload));
  },
  async deferDecision(
    payload: RepoScope & { readonly decisionId: string; readonly reason: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.decision.defer", payload));
  },
  async startTask(
    payload: RepoScope & { readonly taskId: string; readonly executionId: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.start", payload));
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
    return readGuiActionResult(await invoke("repo.task.progress.append", payload));
  },
  async submitTask(
    payload: RepoScope & {
      readonly taskId: string;
      readonly executionId?: string;
      readonly amend?: boolean;
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.submit", payload));
  },
  /** 收口销账的唯一 GUI 写通道:纯机械动作;评审裁决与同意是各自的显式动作。 */
  async completeTask(
    payload: RepoScope & { readonly taskId: string; readonly executionId?: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.complete", payload));
  },
  /** CEO 终审批准:与 `ha task review-consent` 同一条 daemon 动作。 */
  async consentReview(
    payload: RepoScope & { readonly taskId: string; readonly executionId: string; readonly reviewId: string },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.consent", payload));
  },
  /** 台账 pin 的唯一 GUI 写通道:daemon 侧就是 `ha task pin` 的 pinned-only amend。 */
  async assignTask(
    payload: RepoScope & {
      readonly taskId: string;
      readonly expectedVersion: number;
      readonly personId?: string;
      readonly nodeId?: string;
      readonly teamId?: string;
      readonly expiresAt?: string;
    },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.assign", payload));
  },
  async unassignTask(
    payload: RepoScope & { readonly taskId: string; readonly expectedVersion: number },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.unassign", payload));
  },
  async pinTask(payload: RepoScope & { readonly taskId: string }): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.pin", payload));
  },
  async unpinTask(payload: RepoScope & { readonly taskId: string }): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.task.unpin", payload));
  },
  async unpinEntity(payload: RepoScope & { readonly entityRef: string }): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.entity.unpin", payload));
  },
  /** 答复 awaits 的唯一 GUI 写通道:与 `ha relation unrelate` 同一条 relation-unrelate 动作,答复即 retire 理由。 */
  async retireRelation(
    payload: RepoScope & { readonly relationId: string; readonly reason: string; readonly expectedVersion: number },
  ): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.relation.unrelate", payload));
  },
  /**
   * Gate 签发的唯一 GUI 写通道:正式 facet `repo.task.attest`(bridge `taskAttest`),
   * 与 `ha task attest` 同一条 task-attest 动作。payload 是闭形状,daemon 按
   * ActionDeclaration 展开:approve 不带 mode,可选评语走 `note`;override 必须
   * `mode`+`rationale`(trim 后 ≥10 字符,daemon 权威校验)。错误码原样上抛,
   * 由调用方透传,不伪造成功。
   */
  async taskAttest(
    payload: RepoScope & {
      readonly taskId: string;
      readonly gateId: string;
      readonly mode: "approve" | "override";
      readonly note?: string;
      readonly rationale?: string;
    },
  ): Promise<GuiActionResult> {
    const { repoId, taskId, gateId, mode, note, rationale } = payload;
    // invoke 的传参沿用本文件既有惯例:先落成变量再传(facet 注册表在 guiAction 边界
    // 把 payload 类型放宽为索引签名,新鲜字面量会被 excess-property 检查误伤)。
    const request =
      mode === "override"
        ? { repoId, taskId, gateId, result: "pass" as const, mode, ...(rationale ? { rationale } : {}) }
        : { repoId, taskId, gateId, result: "pass" as const, ...(note ? { note } : {}) };
    return readGuiActionResult(await invoke("repo.task.attest", request));
  },
  /** 只读的 canonical receipt 查询,不是重放。 */
  async showReceipt(payload: RepoScope & { readonly opId: string }): Promise<GuiActionResult> {
    return readGuiActionResult(await invoke("repo.receipt.show", payload));
  },
  async getCatalogSnapshot(payload: RepoScope): Promise<CatalogSnapshotSuccess> {
    return readCatalogSnapshot(await invoke("repo.gui.catalog.snapshot", payload));
  },
  async getCatalogPreset(
    payload: RepoScope & { readonly presetId: string; readonly profileId?: string; readonly locale?: string },
  ): Promise<CatalogPresetSuccess> {
    return readCatalogPreset(await invoke("repo.gui.catalog.preset.read", payload));
  },
  async rereadCatalog(payload: RepoScope): Promise<CatalogRereadReceipt> {
    return readCatalogRereadReceipt(await invoke("repo.gui.catalog.reread", payload));
  },
};

function readSettingsResult(value: unknown): SettingsSuccess {
  if (!isSettingsSuccess(value)) throw new Error(localErrorHint(value, "Settings bridge returned an invalid result."));
  return value;
}

function readTaskDispatchesResult(value: unknown): TaskDispatchesRead {
  const result = value as Partial<TaskDispatchesRead> & {
      readonly taskId?: unknown;
      readonly taskIds?: unknown;
      readonly unavailableTaskIds?: unknown;
      readonly page?: unknown;
      readonly agentId?: unknown;
      readonly squadId?: unknown;
      readonly groups?: unknown;
      readonly taskLabels?: unknown;
      readonly totals?: unknown;
      readonly truncated?: unknown;
    },
    taskIds = Array.isArray(result?.taskIds) ? result.taskIds : [],
    unavailableTaskIds = Array.isArray(result?.unavailableTaskIds) ? result.unavailableTaskIds : [],
    single = typeof result?.taskId === "string",
    batch =
      taskIds.length > 0 &&
      taskIds.every((taskId) => typeof taskId === "string") &&
      unavailableTaskIds.every((taskId) => typeof taskId === "string" && taskIds.includes(taskId)) &&
      isQueryPage(result.page),
    member =
      (typeof result?.agentId === "string") !== (typeof result?.squadId === "string") &&
      Array.isArray(result?.groups) &&
      (result.groups as readonly unknown[]).every(
        (group) =>
          isRendererRecord(group) &&
          (group.runtimeSessionIds === undefined ||
            (Array.isArray(group.runtimeSessionIds) && group.runtimeSessionIds.every((id) => typeof id === "string"))),
      ) &&
      Array.isArray(result?.taskLabels) &&
      (result.taskLabels as readonly unknown[]).every(
        (label) => isRendererRecord(label) && typeof (label as { readonly taskId?: unknown }).taskId === "string",
      ) &&
      isRendererRecord(result?.totals) &&
      typeof (result.totals as { readonly sessions?: unknown }).sessions === "number" &&
      typeof result?.truncated === "boolean";
  if (
    !result ||
    result.ok !== true ||
    (result.status !== "ready" && result.status !== "pending") ||
    (single === batch && !member) ||
    !Array.isArray(result.dispatches) ||
    result.dispatches.some(
      (row) =>
        !isRendererRecord(row) ||
        typeof row.dispatchId !== "string" ||
        typeof row.runtimeSessionId !== "string" ||
        !["running", "succeeded", "failed", "unknown", "cancelled", "stopped", "blocked", "lost"].includes(
          String(row.status),
        ),
    ) ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision)
  )
    throw new Error(localErrorHint(value, "Task dispatches bridge returned an invalid result."));
  return result as TaskDispatchesRead;
}

function readTaskDocumentResult(value: unknown): TaskDocumentProjectionRead {
  if (!isTaskDocumentRead(value))
    throw new Error(localErrorHint(value, "Task document bridge returned an invalid result."));
  return value as TaskDocumentProjectionRead;
}

function readTaskListResult(value: unknown): TaskListSuccess {
  const result = value as Partial<TaskListSuccess>;
  if (
    !result ||
    result.ok !== true ||
    !Array.isArray(result.rows) ||
    !result.rows.every(isTaskSnapshotProjectionRow) ||
    !Array.isArray(result.invalidRows) ||
    !result.invalidRows.every(isTaskSnapshotInvalidRow) ||
    (result.status !== "ready" && result.status !== "pending") ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision) ||
    (result.page !== undefined && !isQueryPage(result.page))
  ) {
    throw new Error(localErrorHint(value, "Task list bridge returned an invalid result."));
  }
  return {
    ...repositoryReadFrame(value),
    ok: true,
    status: result.status as "ready" | "pending",
    rows: result.rows,
    invalidRows: result.invalidRows,
    watermark: result.watermark as number,
    sourceRevision: result.sourceRevision as number,
    warnings: Array.isArray(result.warnings)
      ? result.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    ...(result.page ? { page: result.page } : {}),
  };
}

function readTaskWipResult(value: unknown): TaskWipRead {
  const result = value as Partial<TaskWipRead>;
  const validSizes =
    result &&
    Number.isSafeInteger(result.limit) &&
    Number(result.limit) >= 1 &&
    typeof result.limitLabel === "string" &&
    Number.isSafeInteger(result.threshold) &&
    Number(result.threshold) >= 1;
  if (!result || !validSizes || !Array.isArray(result.counted) || !Array.isArray(result.roots))
    throw new Error(localErrorHint(value, "Task WIP bridge returned an invalid result."));
  return result as TaskWipRead;
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
    !["events", "repo-log", "daemon-log", "lifecycle", "dispatch"].includes(String(result.kind)) ||
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
    ...repositoryReadFrame(value),
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

function readRelationFactFacetResult(value: unknown): RelationFactFacetSuccess {
  const result = value as Partial<RelationFactFacetSuccess>;
  if (
    !result ||
    result.ok !== true ||
    result.facet !== "facts" ||
    !Array.isArray(result.facts) ||
    !result.facts.every(isRelationFactSummaryRow) ||
    !isQueryPage(result.page) ||
    !Array.isArray(result.domainTypes) ||
    !result.domainTypes.every(isFactDomainTypeSummaryRow)
  ) {
    throw new Error(localErrorHint(value, "Relation fact facet bridge returned an invalid result."));
  }
  return {
    ...repositoryReadFrame(value),
    ok: true,
    facet: "facts",
    page: result.page,
    facts: result.facts,
    domainTypes: result.domainTypes,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

function isRelationFactSummaryRow(value: unknown): value is RelationFactSummaryRow {
  if (!isRendererRecord(value)) return false;
  return (
    typeof value.anchor === "string" &&
    typeof value.text === "string" &&
    (value.category === "lesson" || value.category === "finding" || value.category === "progress") &&
    (value.taskId === undefined || typeof value.taskId === "string") &&
    (value.archived === undefined || typeof value.archived === "boolean")
  );
}

function readSystemStatus(value: unknown): SystemStatusSuccess {
  if (!isSystemStatusSuccess(value)) throw daemonBridgeError(value, "System status bridge returned an invalid result.");
  return value;
}
function readDaemonControlReceipt(value: unknown): DaemonControlReceipt {
  if (!isDaemonControlReceipt(value))
    throw new Error(localErrorHint(value, "Daemon control bridge returned an invalid receipt."));
  return value;
}

function isSystemStatusSuccess(value: unknown): value is SystemStatusSuccess {
  const guiBuild = isRendererRecord(value) ? value.guiBuild : undefined;
  return (
    isRendererRecord(value) &&
    value.schema === "gui-system-status/v1" &&
    value.ok === true &&
    typeof value.observedAt === "string" &&
    isRendererRecord(value.daemon) &&
    (guiBuild === undefined ||
      (isRendererRecord(guiBuild) && (guiBuild.commit === null || typeof guiBuild.commit === "string"))) &&
    Array.isArray(value.repos) &&
    value.repos.every(
      (repo) =>
        isRendererRecord(repo) &&
        typeof repo.repoId === "string" &&
        typeof repo.displayName === "string" &&
        (repoRegistrationStateWords as readonly string[]).includes(String(repo.registrationState)) &&
        (repoCellStateWords as readonly string[]).includes(String(repo.cellState)),
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
    (daemonControlPhaseWords as readonly string[]).includes(String(value.phase))
  );
}

function isTaskSnapshotProjectionRow(value: unknown): value is TaskSnapshotProjectionRow {
  if (
    !isRendererRecord(value) ||
    typeof value.taskId !== "string" ||
    (value.createdAt !== null && typeof value.createdAt !== "string") ||
    // 老 daemon 下发的行没有 completedAt 字段(undefined):按「无完成时间」放行,
    // 不让整个任务列表读失败(GUI 是 attach-only,新 GUI 会挂到旧构建 daemon)。
    (value.completedAt != null && typeof value.completedAt !== "string") ||
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

function isTaskSnapshotInvalidRow(value: unknown): value is TaskSnapshotInvalidRow {
  return (
    isRendererRecord(value) &&
    Number.isInteger(value.rowIndex) &&
    Number(value.rowIndex) >= 0 &&
    typeof value.taskId === "string" &&
    typeof value.field === "string" &&
    typeof value.message === "string"
  );
}

function isRelationGraphEdgeRow(value: unknown): value is ServedRelationEdgeRow {
  return (
    isRendererRecord(value) &&
    typeof value.sourceRef === "string" &&
    typeof value.targetRef === "string" &&
    typeof value.relationType === "string" &&
    typeof value.current === "boolean"
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
