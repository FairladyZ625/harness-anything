import type { EntityAttributionProjection, RelationType } from "../../api/renderer-dto.ts";

export type CanonicalStatus =
  | "planned"
  | "active"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled";

export type SnapshotStatus = CanonicalStatus | "unknown";

export type Freshness = "fresh" | "stale-but-usable" | "unavailable-no-cache";

export type PackageDisposition = "active" | "archived" | "tombstoned";

export type CloseoutReadiness =
  | "not_required"
  | "missing"
  | "incomplete"
  | "ready"
  | "passed"
  | "failed";

export type EngineId = "local" | "multica" | "github" | "linear";

export type DocGroup = "必读" | "计划" | "设计" | "进度" | "收口" | "证据";

export interface DocEntry {
  path: string;
  title: string;
  group: DocGroup;
  required: boolean;
  /** 文档完成度：true=已存在，false=缺失（required+missing 即收口阻塞项） */
  present: boolean;
}

/** materialization gate / check 结果——任务详情收口区的"原因"维度 */
export interface GateResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface TaskRow {
  taskId: string;
  title: string;
  projectId: string;
  coordinationStatus: SnapshotStatus;
  rawStatus: string;
  freshness: Freshness;
  packageDisposition: PackageDisposition;
  closeoutReadiness: CloseoutReadiness;
  engine: EngineId;
  source: "local-document" | "external-engine" | "snapshot-cache";
  module: string;
  lastKnownAt: string;
  /** closeoutReadiness=ready 的起始时间，用于等待时长统计 */
  waitingSince?: string;
  gates: GateResult[];
  docs: DocEntry[];
  // 三元语继承字段（E47/E49）：默认从 spawningDecision 继承，可覆盖
  riskTier?: RiskTier;
  urgency?: Urgency;
  /** 该 task 由哪条 decision 派生（生成式派生时必填；顶层独立 task 可空） */
  spawningDecision?: string;
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
  attribution: EntityAttributionProjection;
}

/** GUI relation names are the kernel entity-relations/v1 vocabulary verbatim. */
export type RelationKind = RelationType;

export interface RelationEdge {
  /**
   * from/to 形如 <entity>/<id>[/anchor]，实体 ∈ task|decision|fact。
   * 例：task/task_x、decision/dec_y、fact/task_x/F-a3f2、decision/dec_y/C1（锚到 claim）。
   * 语义：from --kind--> to（如 decision/dec_y/C1 evidenced-by fact/task_x/F-a3f2）。
   */
  from: string;
  to: string;
  kind: RelationKind;
  /** ⚠️ 同名陷阱消歧：这是「边的来源」标量；entity 顶层的 provenance 是 session 原文溯源数组（见 DecisionRow/TaskRow），同名不同义 */
  provenance: "local-document" | "external-engine";
  /** 强 relation 的 rationale 必填非空（INV-5）；evidenced-by/derives/supersedes 承重边在此给决策卡证据栏展示 */
  rationale?: string;
}

// ============ 三元语：decision（why，脊梁）============

// schema 无独立 accepted 态:accept 即 active(TP-M3-01 state 枚举)
export type DecisionState =
  | "proposed"
  | "rejected"
  | "deferred"
  | "active"
  | "retired";

export type RiskTier = "low" | "medium" | "high";
export type Urgency = "low" | "medium" | "high";

/** decision 的承重论点 / 选择的策略 / 被否决的策略。evidence 必须沿 relation 可达（E49，防 Goodhart） */
export interface DecisionClaim {
  id: string;
  text: string;
  /** 沿 relation 可达的支撑 fact 锚（fact/<task>/<id>）。空数组 → 覆盖度不足，风化候选 */
  evidence: string[];
  /** rejected 项必填：为何否决（why_not）。chosen 项可空 */
  whyNot?: string;
}

export interface ProvenanceEntry {
  runtime: "claude-code" | "codex" | "antigravity" | "zcode" | string;
  sessionId: string;
  /** 绑定时刻——一个 session 滚动绑多个 entity 时，用它回溯定位「当初那段」 */
  boundAt: string;
}

export interface DecisionRow {
  decisionId: string;
  title: string;
  state: DecisionState;
  riskTier?: RiskTier; // 缺失即未知；不得以 UI 默认值合成风险等级
  urgency?: Urgency; // 缺失即未知；不得以 UI 默认值合成紧急等级
  vertical?: string;
  preset?: string;
  proposedBy?: { kind: "agent" | "human" | "system"; id: string };
  /** arbiter 必须 ≠ proposedBy（防自证） */
  arbiter?: { kind: "agent" | "human" | "system"; id: string };
  proposedAt?: string;
  decidedAt?: string;
  question: string; // 这条决策回答的问题（复现当时场景）
  chosen: DecisionClaim[]; // 决定了什么策略
  rejected: DecisionClaim[]; // ⚠️ 必填非空，每条带 evidence + why_not（否决比选择更重要）
  claims: { id: string; text: string }[]; // 承重论点（覆盖度查询的锚点）
  /** entity 原文溯源（⚠️ 与 RelationEdge.provenance 同名不同义） */
  provenance?: ReadonlyArray<ProvenanceEntry>;
  lastChangedAt?: string;
  /**
   * 决策就绪信号灯(41 §3.1a)。evidence 活性 / 覆盖度由 relation/fact
   * 投影推导；其余可选信号由后续专用投影提供。
   */
  readinessSignals?: {
    /** 黄:propose 后(boundAt 起)applies_to 文档有 commit 触碰。命中给摘要(哪些文档、何时)。 */
    appliesToDrift?: { docs: string[]; lastCommitAt: string };
    /** 红:findConflictMarkers 命中该 decision 包。命中给摘要(coordinator 写入时亦拒,E52 R3)。 */
    conflictMarker?: { summary: string; conflictingEntity: string };
    /** accept 成功后需正文回写(supersede/修订 canonical)→ 收件箱提示派生回写 task(42 §4)。 */
    needsWriteback?: { target: string; kind: "supersede" | "amend" | "new-doc" };
  };
}

// ============ 三元语：fact（is，内嵌 task、无状态机）============

/**
 * fact 是不可变观察，内嵌产出它的 task，不搬家。
 * 稳定短锚形如 task_x/F-a3f2（禁行号）。
 * 失效不靠状态，靠 relation 边（invalidated-by/supersedes-fact）。
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
  /** 是否已被 invalidated-by/supersedes-fact 边标记失效（由图投影推得） */
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

export type PresetSource = "builtin" | "user" | "project";

/** slot → 模板库 templateRef → 物化文件名（locale variants 由模板库存储） */
export interface TemplateSelection {
  slot: string;
  templateRef: string;
  materializeAs: string;
  locales: string[];
}

/** 场景层：声明实体 kind 扩展与文档槽位；statusMapping 不归 Vertical（归 Engine） */
export interface VerticalEntityKind {
  id: string; // task / decision / fact / milestone ...
  /** E48 三类泛化方式：lifecycle=有状态机+scaffold（task/decision）；schema=只定字段（fact）；composite=原语组合（milestone） */
  kind: "lifecycle" | "schema" | "composite";
  contractEntity: boolean; // 承不承重（违反是否 gate 红）
}

export interface VerticalInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  entityKinds: VerticalEntityKind[];
  slots: { slot: string; required: boolean }[];
}

/** 侧挂素材库条目：存正文与 locale variants，被 Vertical/Preset 选择 */
export interface TemplateInfo {
  ref: string;
  kind: string;
  version: string;
  locales: string[];
  usedBy: string[];
  description: string;
}

export interface PresetEntry {
  id: string;
  name: string;
  source: PresetSource;
  version: string;
  description: string;
  /** 所属 vertical id */
  vertical: string;
  /** Spring Boot 风格单父链；冲突/循环 fail closed */
  extends?: string;
  /** 复用走显式 capability 引入，禁隐式多继承 */
  capabilityImports: string[];
  /** preset 内部子配置；budget(simple/standard/complex) 由 profile 吸收 */
  profile?: string;
  /** 物化时横向取用模板库 */
  selections: TemplateSelection[];
  /** 被更高优先级来源覆盖时，指向覆盖者 id */
  overriddenBy?: string;
  /**
   * 看板默认分组维度(信息架构声明)。coding preset 通常=root(milestone=root task)。
   * 可选;未声明时 BoardView 退回自身默认。仅 renderer 侧消费,不动 preset 引擎。
   */
  defaultGroupBy?: "module" | "engine" | "root";
}

export interface AdapterMappingRow {
  raw: string;
  canonical: SnapshotStatus;
}

export interface AdapterInfo {
  engine: EngineId;
  displayName: string;
  connected: boolean;
  /** 认证方式提示，如 "凭证 · keychain"；GUI 不落明文 */
  authHint: string;
  boundCount: number;
  /** local 引擎无快照概念 → null */
  lastSnapshotAt: string | null;
  freshness: Freshness;
  mapping: AdapterMappingRow[];
  /** 出现过但未映射的 raw 状态（产生 unknown），提示补映射 */
  unmappedRaw: string[];
}

export interface EventEntry {
  at: string;
  projectId: string;
  taskId: string;
  summary: string;
}

export const isExternal = (t: TaskRow) => t.engine !== "local";
export const isTerminal = (s: SnapshotStatus) => s === "done" || s === "cancelled";

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
