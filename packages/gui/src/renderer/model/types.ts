import type { DecisionProjectionRow, RelationType, TaskSnapshotProjectionRow } from "../../api/renderer-dto.ts";

export type CanonicalStatus = "planned" | "active" | "blocked" | "in_review" | "done" | "cancelled";

/**
 * GUI adapter superset of the kernel task-status vocabulary plus the explicit
 * unknown (house convention: unknown shows as unknown, e.g. the board's unknown
 * column). Spelled out literally so the status-word register gate can lock this
 * mirror against the kernel vocabulary directly.
 */
export type SnapshotStatus =
  | "planned"
  | "active"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled"
  | "unknown";

export type Freshness = "fresh" | "stale-but-usable" | "unavailable-no-cache";

export type PackageDisposition = "active" | "archived" | "tombstoned";

export type CloseoutReadiness =
  | "not_required"
  | "missing"
  | "incomplete"
  | "ready"
  | "passed"
  | "failed";

export type EngineId = string;

export type DocGroup = "必读" | "计划" | "设计" | "进度" | "收口" | "证据";

export interface DocEntry {
  path: string;
  title: string;
  group: DocGroup;
  required: boolean;
  /** 文档完成度：true=已存在，false=缺失（required+missing 即收口阻塞项） */
  present: boolean;
  /** 未完成文档 read 时不能把 absent 当 missing。 */
  presence?: "present" | "missing" | "unknown";
}

/** materialization gate / check 结果——任务详情收口区的"原因"维度 */
export interface GateResult {
  name: string;
  ok: boolean | null;
  detail?: string;
}

export type BlockingState = "blocked" | "clear" | "unknown";

export interface BlockingContributor {
  relationId: string;
  /** The only writable task→task blocking verb (canonical direction: source is blocked). */
  kind: "depends-on";
  sourceTaskId: string;
  targetTaskId: string;
  rationale?: string;
}

export interface TaskRow {
  taskId: string;
  title: string;
  projectId: string;
  coordinationStatus: SnapshotStatus;
  /** Task/v1 真状态；relation overlay 永不覆写此字段。 */
  canonicalStatus?: CanonicalStatus;
  blocking?: BlockingState;
  blockingLabel?: string;
  blockers?: BlockingContributor[];
  blockingWarnings?: string[];
  rawStatus: string;
  freshness: Freshness;
  packageDisposition: PackageDisposition;
  closeoutReadiness: CloseoutReadiness;
  engine: EngineId;
  origin?: "native" | "archival" | "external";
  source: "local-document" | "external-engine" | "snapshot-cache";
  module: string;
  moduleKeys?: string[];
  productLines?: string[];
  placementWarning?: string;
  placementProvenance?: ReadonlyArray<{ kind: "l2" | "decision-relation" | "canonical-event"; ref: string }>;
  packagePath?: string | null;
  taskClass?: NonNullable<TaskSnapshotProjectionRow["snapshot"]["task"]>["taskClass"];
  workKind?: NonNullable<NonNullable<TaskSnapshotProjectionRow["snapshot"]["task"]>["metadata"]>["workKind"];
  vertical?: string;
  preset?: string;
  profile?: string;
  createdBy?: string;
  currentNode?: "implementation" | "review";
  iteration?: 0 | 1;
  activeExecutionId?: string;
  leaseExpiresAt?: string;
  events?: EventEntry[];
  /** task_bootstrapped occurredAt; null when the ledger has no reliable creation event. */
  createdAt?: string | null;
  lastKnownAt: string;
  /** closeoutReadiness=ready 的起始时间，用于等待时长统计 */
  waitingSince?: string;
  gates: GateResult[];
  closeoutBlocker?: TaskSnapshotProjectionRow["closeoutAssessment"]["blocker"];
  snapshotAvailability?: TaskSnapshotProjectionRow["snapshotAvailability"];
  reviews?: TaskSnapshotProjectionRow["snapshot"]["reviews"];
  consents?: TaskSnapshotProjectionRow["snapshot"]["consents"];
  codeDocWitnesses?: TaskSnapshotProjectionRow["snapshot"]["codeDocWitnesses"];
  gateWitnesses?: TaskSnapshotProjectionRow["snapshot"]["gateWitnesses"];
  /** execution 快照原样透传(W5:执行证据页并入 Task 详情「收口」页签)。 */
  executions?: TaskSnapshotProjectionRow["snapshot"]["executions"];
  /** execution evidence 投影原样透传(同上)。 */
  executionEvidence?: TaskSnapshotProjectionRow["executionEvidence"];
  docs: DocEntry[];
  // 三元语继承字段（E47/E49）：默认从 spawningDecision 继承，可覆盖
  riskTier?: RiskTier;
  urgency?: Urgency;
  /** 该 task 由哪条 decision 派生（生成式派生时必填；顶层独立 task 可空） */
  spawningDecision?: string;
  /**
   * 台账 pin(task/v1 `pinned`,经 `ha task pin` 写入):「我当下正在做的」,
   * 与 coordinationStatus=active 正交——进行中未必在做,在做未必进行中。
   */
  pinned?: boolean;
  /** entity 原文溯源（⚠️ 与 RelationEdge.provenance 同名不同义） */
  provenance?: ReadonlyArray<ProvenanceEntry>;
  /**
   * 直接父任务（task 树层级，来自 projection frontmatter `parent` 字段）。
   * 与 spawningDecision 不同:这是 task→task 的层级关系,不是 decision 派生。
   */
  parentTaskId?: string;
  /**
   * 任务树的根 taskId(沿 parentTaskId 上溯到顶层)。根任务的 rootTaskId=自身。
   * 用于「按 milestone/root task 分组」(milestone 在内核=根 task)。
   */
  rootTaskId?: string;
  /** root task 的标题(查表填入,便于分组标签展示) */
  rootTitle?: string;
}

/** GUI relation names are the kernel entity-relations/v1 vocabulary verbatim. */
export type RelationKind = RelationType;

export interface RelationEdge {
  relationId?: string;
  /**
   * from/to 形如 <entity>/<id>[/anchor]，实体 ∈ task|decision|fact。
   * 例：task/task_x、decision/dec_y、fact/task_x/F-a3f2、decision/dec_y/C1（锚到 claim）。
   * 语义：from --kind--> to（如 decision/dec_y/C1 evidenced-by fact/task_x/F-a3f2）。
   */
  from: string;
  to: string;
  kind: RelationKind;
  direction?: "directed" | "undirected";
  state?: "active" | "edge_retired" | "deleted";
  /** ⚠️ 同名陷阱消歧：这是「边的来源」标量；entity 顶层的 provenance 是 session 原文溯源数组（见 DecisionRow/TaskRow），同名不同义 */
  provenance: "local-document" | "external-engine";
  /** 强 relation 的 rationale 必填非空（INV-5）；evidenced-by/derives/supersedes 承重边在此给决策卡证据栏展示 */
  rationale?: string;
}

// ============ 三元语：decision（why，脊梁）============

/**
 * Mirror of the kernel decision-state vocabulary (decisionStates, 6 words) plus the
 * explicit unknown. The status-word register ratchet gate locks this mirror against
 * the kernel, and `superseded` must stay distinct (ADR-0020 D1): a superseded
 * decision is not awaiting approval, and a value outside the vocabulary renders as
 * unknown, never as a plausible neighbour.
 */
export type DecisionState =
  | "proposed"
  | "rejected"
  | "deferred"
  | "superseded"
  | "in_effect"
  | "outcome_retired"
  | "unknown";

export type RiskTier = "low" | "medium" | "high";
export type Urgency = "low" | "medium" | "high";

/** decision 的承重论点 / 选择的策略 / 被否决的策略。evidence 必须沿 relation 可达（E49，防 Goodhart） */
export interface DecisionClaim {
  id: string;
  text: string;
  /** chosen option rationale; rejected options use whyNot. */
  rationale?: string;
  /** 沿 relation 可达的支撑 fact 锚（fact/<task>/<id>）。空数组 → 覆盖度不足，风化候选 */
  evidence: string[];
  /** rejected 项必填：为何否决（why_not）。chosen 项可空 */
  whyNot?: string;
}

export interface DecisionLoadBearingClaim {
  id: string;
  text: string;
  loadBearing: boolean;
  fulfillment: "evidenced" | "delivered" | "standing_policy" | null;
}

export type DecisionJudgmentConsent = DecisionProjectionRow["judgmentConsents"][number];
export type DecisionBody = NonNullable<DecisionProjectionRow["body"]>;

export interface ProvenanceEntry {
  runtime: "claude-code" | "codex" | "antigravity" | "zcode" | string;
  sessionId: string;
  /** 绑定时刻——一个 session 滚动绑多个 entity 时，用它回溯定位「当初那段」 */
  boundAt: string;
}

export interface DecisionRow {
  decisionId: string;
  legacyId?: string;
  path?: string;
  title: string;
  state: DecisionState;
  riskTier?: RiskTier; // 缺失即未知；不得以 UI 默认值合成风险等级
  urgency?: Urgency; // 缺失即未知；不得以 UI 默认值合成紧急等级
  vertical?: string;
  preset?: string;
  decisionClass?: "ordinary" | "standing_policy";
  workspaceRevision?: number;
  proposedBy?: { kind: "agent" | "human" | "system"; id: string };
  /** arbiter 必须 ≠ proposedBy（防自证） */
  arbiter?: { kind: "agent" | "human" | "system"; id: string };
  proposedAt?: string;
  decidedAt?: string;
  question: string; // 这条决策回答的问题（复现当时场景）
  chosen: DecisionClaim[]; // 决定了什么策略
  rejected: DecisionClaim[]; // ⚠️ 必填非空，每条带 evidence + why_not（否决比选择更重要）
  claims: DecisionLoadBearingClaim[]; // 覆盖度只消费 canonical coverageRows,不从 option evidence 猜
  judgmentConsents: DecisionJudgmentConsent[];
  body?: DecisionBody | null;
  appliesTo?: { modules: string[]; productLines: string[] };
  /** entity 原文溯源（⚠️ 与 RelationEdge.provenance 同名不同义） */
  provenance?: ReadonlyArray<ProvenanceEntry>;
  lastChangedAt?: string;
  /**
   * 决策就绪信号灯(41 §3.1a)。evidence 活性 / 覆盖度由 relation/fact
   * 投影推导；其余可选信号由后续专用投影提供。
   */
  readinessSignals?: {
    /** canonical commit cut 相对 proposedAt 的 applies_to 变化；无法解析 scope 时保持 unknown。 */
    appliesToDrift?: { state: "clear" | "drift" | "unknown"; paths: string[]; lastCommitAt: string | null; summary: string };
    /** 只扫描 canonical commit blobs,不读取未提交工作树。 */
    conflictMarker?: { state: "clear" | "conflict" | "unknown"; paths: string[]; summary: string };
    /** accept 成功后需正文回写(supersede/修订 canonical)→ 收件箱提示派生回写 task(42 §4)。 */
    needsWriteback?: { target: string; kind: "supersede" | "amend" | "new-doc" };
  };
}

// ============ 三元语：fact（is，内嵌 task、无状态机）============

/**
 * fact 是不可变观察，内嵌产出它的 task，不搬家。
 * 稳定短锚形如 task_x/F-a3f2（禁行号）。
 * 失效不靠状态，靠 relation 边（规范方向：fact --supersedes-fact--> fact，仅 target 失效）。
 */
export interface FactRef {
  anchor: string; // task_x/F-a3f2
  taskId: string;
  category: "finding" | "progress" | "lesson";
  text: string;
  at: string;
  /** Immutable observation confidence from task-fact-row/v1. */
  confidence: "low" | "medium" | "high";
  /** Authored fact source, passed through from task-fact-row/v1. */
  source?: string;
  /** Authored fact provenance, passed through from task-fact-row/v1. */
  provenance?: ReadonlyArray<ProvenanceEntry>;
  /** 是否已被 supersedes-fact 边指向而失效（由图投影推得） */
  invalidated?: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  preset: string;
  engines: EngineId[];
  /** 投影 watermark 时间 */
  watermarkAt: string;
  // 三元语投影计数
  decisionCount?: number;
  factCount?: number;
}

export interface EventEntry {
  at: string;
  projectId: string;
  taskId: string;
  summary: string;
}

export const isExternal = (t: TaskRow) => t.origin === "external" || (t.origin === undefined && t.engine !== "local");
export const isTerminal = (s: SnapshotStatus) =>
  /* @gate-identity check-gui-status-judgments/gui-status-039 */
  s === "done" ||
  /* @gate-identity check-gui-status-judgments/gui-status-040 */
  s === "cancelled";

export const BOARD_COLUMNS: SnapshotStatus[] = [
  "planned",
  "active",
  "blocked",
  "in_review",
  "done",
  "cancelled",
  "unknown",
];

export const DOC_GROUPS: DocGroup[] = ["必读", "计划", "设计", "进度", "收口", "证据"];
