import type {
  DecisionAcceptReviewReadiness,
  DecisionProjectionRow,
  ProjectionPage,
  ProjectionWarning,
  RelationCoverageRow,
  RelationFactRow,
  RelationGraphEdgeRow,
  TaskProjection,
  TaskWipRootRow,
} from "@harness-anything/kernel";
import type { PackageDisposition } from "@harness-anything/kernel/internal/domain/package-disposition.ts";
import type { CollaboratorScope } from "@harness-anything/kernel/internal/domain/collaborator-scope.ts";
import type { DispatchLifecycleSummary } from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import type { DomainStatus } from "@harness-anything/kernel/internal/domain/lifecycle-status.ts";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import type { FreshnessReason } from "@harness-anything/kernel";
import type { AgendaAttentionItem, AgendaRegionWeights } from "./agenda-wire.ts";
import type { TaskDeliveryStage } from "./task-delivery-stage.ts";
import type { TaskWorkspaceView } from "./task-workspace-read.ts";
export type { TaskWorkspaceView };

type TaskProjectionListRow = ReturnType<TaskProjection["list"]>["rows"][number];
type TaskProjectionWarning = ReturnType<TaskProjection["list"]>["warnings"][number];

export type DaemonRelationGraphFacet = "edges" | "facts" | "coverageRows" | "runtimeEdges";

export interface DaemonRelationEdgeFacetPayload {
  readonly facet: "edges";
  readonly limit?: number;
  readonly cursor?: string;
  readonly relationType?: string;
  readonly state?: string;
  readonly direction?: "directed" | "undirected";
}

export type DaemonRelationGraphFacetPayload =
  | DaemonRelationEdgeFacetPayload
  | { readonly facet: "facts"; readonly limit?: number; readonly cursor?: string }
  | { readonly facet: "coverageRows" | "runtimeEdges" };

export interface DaemonFactSummaryRow {
  readonly anchor: string;
  readonly text: string;
  readonly category: "lesson" | "finding" | "progress";
  readonly taskId?: string;
  /** `fact_archived` 投影态(dec_62CAE6CA):读面如实携带,默认过滤在 GUI 消费端。 */
  readonly archived?: boolean;
}

type EventProjectionCut = Pick<
  ReturnType<TaskProjection["readRelationQuery"]>,
  "status" | "watermark" | "sourceRevision"
>;
type DaemonRelationGraphProjection = {
  readonly edges: readonly DaemonRelationGraphEdgeRow[];
  readonly factAnchors: ReturnType<TaskProjection["readFactAnchors"]>["rows"];
  readonly facts: readonly RelationFactRow[];
  readonly warnings: readonly ProjectionWarning[];
};

export type DaemonRelationGraphEdgeRow = RelationGraphEdgeRow & { readonly current: boolean };

type ServedCoverageRow = RelationCoverageRow & { readonly freshnessReason?: FreshnessReason };

export type DaemonRelationGraphFullResult = { readonly ok: true } & EventProjectionCut &
  DaemonRelationGraphProjection & {
    /** Coverage rows as served: the kernel row plus the optional uncovered-cause
     * classification (kernel `freshnessReasonOf`), attached only to uncovered rows.
     * Optional so older daemons and every persisted record shape stay valid. */
    readonly coverageRows: readonly ServedCoverageRow[];
    readonly page?: ProjectionPage;
    /** Set only on neighborhood reads: edges exist beyond the served depth window. */
    readonly truncated?: boolean;
  };

type EmptyRelationFacetRows = {
  readonly edges: readonly [];
  readonly coverageRows: readonly [];
  readonly factAnchors: readonly [];
  readonly facts: readonly [];
  readonly warnings: readonly ProjectionWarning[];
  readonly domainTypes: readonly [];
};

export type DaemonRelationGraphFacetResult =
  | ({ readonly ok: true; readonly facet: "edges" } & EventProjectionCut &
      Omit<EmptyRelationFacetRows, "edges"> & {
        readonly edges: DaemonRelationGraphProjection["edges"];
        readonly page: ProjectionPage;
      })
  | ({ readonly ok: true; readonly facet: "coverageRows" } & EventProjectionCut &
      Omit<EmptyRelationFacetRows, "coverageRows"> & {
        readonly coverageRows: readonly ServedCoverageRow[];
      })
  | ({ readonly ok: true; readonly facet: "facts" } & EventProjectionCut &
      Omit<EmptyRelationFacetRows, "facts" | "domainTypes"> & {
        readonly facts: readonly DaemonFactSummaryRow[];
        readonly page: ProjectionPage;
        readonly domainTypes: ReturnType<TaskProjection["listFactDomainTypes"]>["domainTypes"];
      })
  | ({ readonly ok: true; readonly facet: "runtimeEdges" } & Omit<EmptyRelationFacetRows, "edges"> & {
        readonly edges: readonly DaemonRelationGraphEdgeRow[];
      });

export type DaemonRelationGraphResult = DaemonRelationGraphFullResult | DaemonRelationGraphFacetResult;

export interface DaemonDecisionSummaryRow {
  readonly decisionId: string;
  readonly title: string;
  readonly state: DecisionProjectionRow["state"];
  readonly riskTier: DecisionProjectionRow["riskTier"];
  readonly urgency: DecisionProjectionRow["urgency"];
  readonly proposedAt: DecisionProjectionRow["proposedAt"];
}

export interface DaemonDecisionReviewDispatchRow {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly personId?: string | null;
  readonly nodeId?: string | null;
  readonly status: Extract<DispatchLifecycleSummary["displayStatus"], "running" | "succeeded" | "failed" | "unknown">;
  readonly reviewContentDigest: string;
  readonly reportRef: string | null;
  /** 评审人显示名:派工头的 agentName,缺名时为 agentId。 */
  readonly reviewer: string | null;
  /** 该派工登记的评审提出的意见数;评审尚未登记为 null。 */
  readonly findingCount: number | null;
}

export type DaemonDecisionFullRow = DecisionProjectionRow & {
  readonly currentReviewContentDigest: `sha256:${string}` | null;
  readonly acceptReviewReadiness: DecisionAcceptReviewReadiness | null;
  readonly reviewDispatches: readonly DaemonDecisionReviewDispatchRow[];
};

export interface DaemonDecisionListPayload extends CollaboratorScope {
  readonly involvement?: "all" | "mine";
  readonly projection?: "summary" | "full";
  readonly state?: DecisionProjectionRow["state"];
}

export type DaemonDecisionListResult =
  | {
      readonly ok: true;
      readonly projection?: "full";
      readonly decisions: readonly DaemonDecisionFullRow[];
      readonly warnings: readonly ProjectionWarning[];
    }
  | {
      readonly ok: true;
      readonly projection: "summary";
      readonly decisions: readonly DaemonDecisionSummaryRow[];
      readonly warnings: readonly ProjectionWarning[];
    };

export interface TaskPlacementSupplement {
  readonly productLines: readonly string[];
  readonly spawningDecisionIds: readonly string[];
  readonly parentTaskId: string | null;
  readonly origin: "native" | "archival" | "external";
  readonly engine: string;
  readonly packageDisposition: PackageDisposition;
  readonly provenance: readonly {
    readonly kind: "l2" | "decision-relation" | "canonical-event";
    readonly ref: string;
  }[];
}

export interface ExecutionEvidenceProjection {
  readonly executionId: string;
  readonly origin: "native" | "archival";
  readonly outputs: readonly {
    readonly evidenceId: string;
    readonly locator: string;
    readonly substrate: "repository-path" | "uri" | "canonical-event" | "opaque";
    readonly checkerReceiptRef: string | null;
    readonly checkerResult: "pass" | "fail" | "unknown";
  }[];
}

export type GuiSubmissionV1 = import("@harness-anything/kernel").SubmissionV1;

/** One projected document under a task package (paths relative to the package root, e.g. artifacts/report.md). */
export interface TaskDocumentListEntryRow {
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  /** True when the worktree file diverges from the committed projection (or exists only
   * in the worktree): the GUI marks these documents as not yet committed. */
  readonly uncommitted: boolean;
}

export type DaemonTaskDocumentListResult = {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly taskId: string;
  readonly documents: readonly TaskDocumentListEntryRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
};

/**
 * The daemon-owned delivery-stage judgment for the live floor (task-delivery-stage.ts):
 * where a task sits on the 实现 → 交付/PR·CI → 评审 → 等业主 → 可合并 main path, plus the
 * pipeline surroundings — `queued` (planned), `waiting_upstream` (depends-on block) and
 * `done` (terminal within TASK_DELIVERY_DONE_WINDOW_MS, 24h). `null` = genuinely off the
 * pipeline (cancelled, terminal older than the window, unrecognized status); `undefined`
 * on the wire means an older daemon build that does not project the field yet.
 */
export type DaemonTaskSnapshotListResult = {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly rows: readonly (TaskProjectionListRow & {
    /** Current assignment aggregate CAS version, including retired assignment relations. */
    readonly assignmentRevision?: number;
    readonly coordinationStatus:
      | import("@harness-anything/kernel/internal/domain/lifecycle-status").DomainStatus
      | "unknown";
    readonly snapshotAvailability: {
      readonly consents: "known" | "unknown";
      readonly gateWitnesses: "known" | "unknown";
    };
    readonly closeoutAssessment: import("@harness-anything/kernel/internal/domain/closeout-readiness").CloseoutAssessment;
    readonly blockingAssessment: import("@harness-anything/kernel/internal/domain/task-blocking").BlockingAssessment;
    readonly deliveryStage: TaskDeliveryStage | null;
    readonly placement: TaskPlacementSupplement;
    readonly executionEvidence: readonly ExecutionEvidenceProjection[];
    readonly board: import("@harness-anything/kernel/internal/domain/task-board-projection").TaskBoardPlacement;
    readonly visibility: import("@harness-anything/kernel/internal/domain/task-board-projection").TaskVisibility;
    readonly capabilities: readonly import("@harness-anything/kernel/internal/domain/task-board-projection").TaskCapability[];
    readonly phase: import("@harness-anything/kernel/internal/domain/task-board-projection").TaskPhase;
    readonly risk: import("@harness-anything/kernel/internal/domain/task-board-projection").TaskRisk;
    readonly workspace: TaskWorkspaceView | null;
  })[];
  readonly invalidRows: readonly DaemonTaskSnapshotInvalidRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly TaskProjectionWarning[];
  readonly page?: ProjectionPage;
};

export type DaemonTaskWipResult = {
  readonly ok: true;
  readonly limit: number;
  readonly limitLabel: string;
  readonly counted: readonly {
    readonly taskId: string;
    readonly status: import("@harness-anything/kernel/internal/domain/task-wip-policy").TaskWipOccupyingStatus;
    readonly title: string;
  }[];
  readonly roots: readonly TaskWipRootRow[];
  readonly threshold: number;
};

export interface DaemonTaskSnapshotInvalidRow {
  readonly rowIndex: number;
  readonly taskId: string;
  readonly field: string;
  readonly message: string;
}

export type DaemonWorkspaceSummaryResult = {
  readonly schema: "daemon.workspace-summary/v1";
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly tasks: import("@harness-anything/kernel/internal/domain/workspace-summary").WorkspaceTaskSummary;
  readonly decisions: import("@harness-anything/kernel/internal/domain/workspace-summary").WorkspaceDecisionSummary;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly ProjectionWarning[];
};

/** The work an agenda row belongs to: its nearest work root (dec_5F7E74F1). */
export interface AgendaWorkRef {
  readonly taskId: string;
  readonly title: string;
}

export interface AgendaTaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly work: AgendaWorkRef | null;
  readonly status: DomainStatus;
  readonly pinned: boolean;
  readonly updatedAt: string;
  readonly leaseExecutionId: string | null;
  readonly activeExecutionIds: readonly string[];
  readonly blockingAssessment: import("@harness-anything/kernel/internal/domain/task-blocking").BlockingAssessment;
  readonly workspace: TaskWorkspaceView | null;
}

/**
 * 待你重启:active execution 的 lease 已释放、且没有存活 dispatch/runtime。没有 worker 在跑,
 * 「只需等」是错的;`next` 直接取 kernel 里 `ha task show` 的同一 completion next,不在 agenda
 * 另判一个命令。
 */
export interface AgendaRestartRow extends AgendaTaskRow {
  readonly next: string;
}

/**
 * 待派审 / 评审中的 execution 行。task 状态决定分组(submitted → awaitingAdjudication,
 * in_review → underReview),组即类型,行内不再携带 kind 判别。
 */
export interface AgendaExecutionRow {
  readonly taskId: string;
  readonly title: string;
  readonly work: AgendaWorkRef | null;
  readonly pinned: boolean;
  readonly executionId: string;
  readonly submittedAt: string;
  readonly blockingAssessment: import("@harness-anything/kernel/internal/domain/task-blocking").BlockingAssessment;
}

export interface AgendaDecisionRow {
  readonly decisionId: string;
  readonly title: string;
  readonly riskTier: "low" | "medium" | "high";
  readonly urgency: "low" | "medium" | "high";
  readonly proposedAt: string;
}
/** 评审中的 Decision 行:另带当前切面上在飞的每位评审人与其已登记的意见数。 */
export interface AgendaDecisionReviewRow extends AgendaDecisionRow {
  readonly reviewers: readonly Pick<DaemonDecisionReviewDispatchRow, "dispatchId" | "reviewer" | "findingCount">[];
}
/**
 * 「待业主处理」行:无人值守派工的提问,或自动处置被守卫拒绝后的升级。`attention` 区分二者:
 * question 的答案来自 worker ruling artifact 或 daemon receipt;guard 不是提问,行上的 question
 * 字段携带可直接执行的处理说明。
 */
export interface AgendaRulingRow {
  readonly taskId: string;
  readonly title: string;
  readonly work: AgendaWorkRef | null;
  readonly pinned: boolean;
  readonly dispatchId: string;
  readonly executionId: string;
  readonly attention: "question" | "guard";
  readonly question: string;
  readonly options: readonly string[];
  /** Worker-authored rulings have an artifact; daemon incident escalation is carried by the dispatch receipt. */
  readonly rulingPath?: string;
  readonly askedAt: string;
  readonly blockingAssessment: import("@harness-anything/kernel/internal/domain/task-blocking").BlockingAssessment;
}
/**
 * 「等你处理」行:一条指向读者本人的 active awaits 边(dec_DF67F23066BAFE444190A191B5/CH2)。
 * 答复 = `ha relation unrelate <relationId> --reason <答复> --expected-version <relationRevision>`。
 */
export interface AgendaAwaitsRow {
  readonly relationId: string;
  readonly relationRevision: number;
  /** task/<id> 或 decision/<id>。 */
  readonly sourceRef: string;
  readonly title: string;
  readonly status: string;
  readonly wakeTaskId?: string;
  readonly personId: string;
  readonly askKind: import("@harness-anything/kernel/internal/domain/task-blocking").AwaitsAskKind;
  readonly question: string;
  readonly askedAt: string;
  /** 提问者:建边 actor 的 agent id,无 agent 时为其 person id。 */
  readonly askedBy: string;
}
/**
 * 「已答复,待你跟进」行:读者名下(task 创建者 / decision 提案者)源实体上已被答复退役的 awaits 边。
 * 退出条件:源实体在答复之后有任何写入(进度、状态、裁决等)即出列,不另存「已读」状态。
 */
export interface AgendaAnsweredRow {
  readonly relationId: string;
  /** task/<id> 或 decision/<id>。 */
  readonly sourceRef: string;
  readonly title: string;
  readonly status: string;
  /** 被问的人(awaits 目标)。 */
  readonly personId: string;
  readonly askKind: import("@harness-anything/kernel/internal/domain/task-blocking").AwaitsAskKind;
  readonly question: string;
  /** 答复原文 = retire 理由。 */
  readonly answer: string;
  readonly answeredAt: string;
  /** 答复者:retire actor 的 agent id,无 agent 时为其 person id。 */
  readonly answeredBy: string;
}
export interface AgendaPinnedEntityRow {
  readonly ref: string;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly pinnedAt: string;
  readonly personIds?: readonly string[];
}

export type DaemonAgendaResult = {
  readonly todos: readonly { readonly id: string; readonly text: string; readonly ref: string }[];
  readonly schema: "daemon.agenda/v1";
  readonly ok: true;
  readonly command: "agenda";
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly pinnedEntities: readonly AgendaPinnedEntityRow[];
  readonly pinnedEntityOverflow: number;
  /** 等你处理:指向读者本人(读绑定的 principal)的 active awaits 边。 */
  readonly awaitingYou: readonly AgendaAwaitsRow[];
  /** 已答复,待你跟进:读者名下源实体上已答复、源实体此后尚无写入的 awaits 边。 */
  readonly answeredForYou: readonly AgendaAnsweredRow[];
  /** All actionable rows in canonical attention order. */
  readonly attentionItems: readonly AgendaAttentionItem[];
  /** Dashboard region weights derived from the same attention scores. */
  readonly regionWeights: AgendaRegionWeights;
  readonly inFlight: readonly AgendaTaskRow[];
  /** Active tasks with neither a live lease nor activity in the last seven days. */
  readonly stalled: readonly AgendaTaskRow[];
  /** active execution 的 lease 已释放且无存活 dispatch/runtime；`next` 与 ha task show 同源。 */
  readonly awaitingRestart: readonly AgendaRestartRow[];
  /** 评审打回、等使用者修:active 且最新 execution=changes_requested、无 lease、无 active execution。 */
  readonly awaitingRework: readonly AgendaTaskRow[];
  /** 无自动评审要求或历史待转交的 submitted execution；按冻结契约处理。 */
  readonly awaitingAdjudication: readonly AgendaExecutionRow[];
  /** 评审中/等 consent:task 状态 in_review、未被 approved 评审了结的 execution 行;报告就绪后 `ha task review-consent`。 */
  readonly underReview: readonly AgendaExecutionRow[];
  /** 当前切面已有在飞 reviewer；下一步等待或查看 runtime。 */
  readonly decisionReviewInProgress: readonly AgendaDecisionReviewRow[];
  /** 当前策略要求独立评审且没有在飞 reviewer；下一步 `ha decision dispatch-review <id>`。 */
  readonly awaitingDecisionReview: readonly AgendaDecisionRow[];
  /** 待裁 decision 行;下一步 `ha decision accept|reject|defer`。 */
  readonly awaitingDecision: readonly AgendaDecisionRow[];
  /**
   * 无人值守派工停下等业主裁决;下一步按选项答复后用 `ha agent run --resume-dispatch` 续派。
   * 可选:daemon 现在总是发出它,而更早的 agenda 读者不认识这个键——声明为可选让两侧都不必
   * 为一个新增分组升级读契约(读方按 `?? []` 处理缺席)。
   */
  readonly awaitingRuling?: readonly AgendaRulingRow[];
  readonly waitingOnOthers: readonly AgendaTaskRow[];
  readonly dispatchable: readonly AgendaTaskRow[];
  readonly page: {
    readonly sourceLimit: number;
    readonly cursor: string | null;
    readonly nextCursor: string | null;
  };
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly ProjectionWarning[];
  readonly summary: string;
};
