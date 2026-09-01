import type { ViewId } from "./navigation/viewHistory.ts";

/**
 * 实体说明面(dec_2935057783CD5D56E9F287AE4D CH4)的说明内容目录。
 *
 * 这是一个**静态策展目录**:renderer 不能在浏览器里 import kernel(kernel 带
 * node 内置模块),所以说明内容在这里以数据形式落地。它与代码实况的一致性
 * 由 test/entity-docs-contract.vitest.ts 锚定——字段名/必填位/状态词表/
 * 关系三元组/写入动作逐项对照 kernel `explainEntityKind` 与 canonical 关系
 * 方向注册表,漂移即红。新增字段不同步这里会被测试拦下,不会静默过期。
 *
 * 中文是这个面的第一语言(与 rebuild 线产品文案一致);字段名、枚举词与
 * ref 模板保持机器字面量,不翻译。
 */

export interface EntityFieldDoc {
  /** schema 字段名(机器字面量)。 */
  readonly name: string;
  readonly required: boolean;
  /** schema 形状摘要:string / enum / object / array … */
  readonly shape: string;
  /** 人话含义;只解释 schema 里真实存在的字段。 */
  readonly meaning: string;
}

export interface EntityEdgeDoc {
  /** 关系动词(canonical relation type)。 */
  readonly type: string;
  readonly sourceKind: string;
  readonly targetKind: string;
}

/**
 * 目录里由 kernel 决定的那一半:schema id、ref 模板、状态词表、可执行动作。
 * 这四项在 kernel 有权威,**不手写**——由 `tools/generate-entity-doc-contract.mjs`
 * 从 `explainEntityKind` 投影进下面的 generated 区块。人只写「它是什么」那一半。
 */
export interface EntityKernelContract {
  readonly schemaId: string | null;
  readonly refTemplate: string | null;
  readonly statuses: readonly { readonly field: string; readonly words: readonly string[] }[];
  readonly actions: readonly string[];
}

export interface EntityKindDoc {
  readonly kind: string;
  /** kernel `explainEntityKind(kind).documentSchema.id`;目录实体(preset/adapter)为 null。 */
  readonly schemaId: string | null;
  /** canonical ref 模板,如 task/{id};relation 是 relation/rel_<16hex>。 */
  readonly refTemplate: string | null;
  /** 存放位置:包目录 / 事件流 / 声明文件。 */
  readonly storage: string;
  /** 一句人话:它是什么。 */
  readonly definition: string;
  readonly fields: readonly EntityFieldDoc[];
  /** 嵌套核心字段(如 fact/decision 的 payload);容器名即外层字段名。 */
  readonly nestedFields: readonly { readonly container: string; readonly fields: readonly EntityFieldDoc[] }[];
  /** 状态词表,逐字来自 kernel statusVocabulary。 */
  readonly statuses: readonly { readonly field: string; readonly words: readonly string[] }[];
  /** 触到本 kind 的全部 canonical 关系三元组(出任一端都算)。 */
  readonly edges: readonly EntityEdgeDoc[];
  /** kernel 动作目录里登记的写入动作 id。 */
  readonly actions: readonly string[];
  /** GUI 里看实况的入口;null = 当前没有专页(如实说明,不硬造)。 */
  readonly guiEntry: { readonly view: ViewId; readonly note: string } | null;
  /** 本仓活行数的读取面;null = 没有廉价的既有读面,不显示计数。 */
  readonly liveCount: "tasks" | "decisions" | "agents" | "squads" | "schedules" | "presets" | "adapters" | null;
}

export interface EntityDocGroup {
  readonly id: "triad" | "runtime" | "catalog";
  readonly title: string;
  readonly summary: string;
  readonly docs: readonly EntityKindDoc[];
}

const field = (name: string, required: boolean, shape: string, meaning: string): EntityFieldDoc => ({
  name,
  required,
  shape,
  meaning,
});

const noNested: readonly { readonly container: string; readonly fields: readonly EntityFieldDoc[] }[] = [];

// entity-kind-contract:generated:start
/** Kernel-derived half of the catalog. Regenerate with tools/generate-entity-doc-contract.mjs. */
export const KERNEL_ENTITY_CONTRACT = Object.freeze({
  agent: {
    schemaId: "agent-declaration/v1",
    refTemplate: "agent/{id}",
    statuses: [],
    actions: ["install", "validate", "list", "inspect"],
  },
  decision: {
    schemaId: "decision-package",
    refTemplate: "decision/{id}",
    statuses: [
      {
        field: "state",
        words: ["proposed", "in_effect", "rejected", "deferred", "superseded", "outcome_retired"],
      },
    ],
    actions: [
      "propose",
      "accept",
      "reject",
      "defer",
      "supersede",
      "retire",
      "amend",
      "repin",
      "declare-claim",
      "fulfill-claim",
      "transition",
      "reckon",
      "validate",
      "list",
      "show",
    ],
  },
  execution: {
    schemaId: "Execution/v1",
    refTemplate: "execution/{id}",
    statuses: [
      {
        field: "state",
        words: ["active", "submitted", "accepted", "changes_requested", "abandoned"],
      },
    ],
    actions: [],
  },
  fact: {
    schemaId: "fact-event",
    refTemplate: "fact/{id}",
    statuses: [
      {
        field: "state",
        words: ["standing", "superseded_fact"],
      },
    ],
    actions: ["record", "reclassify", "type-register", "search", "type-list", "show"],
  },
  person: {
    schemaId: "person/v1",
    refTemplate: "person/{id}",
    statuses: [],
    actions: ["add", "set-role", "bind", "delegate", "revoke-delegation", "remove"],
  },
  policy: {
    schemaId: "policy/v1",
    refTemplate: "policy/{id}",
    statuses: [],
    actions: [],
  },
  relation: {
    schemaId: "Relation/v1",
    refTemplate: "relation/{id}",
    statuses: [
      {
        field: "state",
        words: ["active", "edge_retired", "deleted"],
      },
    ],
    actions: ["relate", "unrelate"],
  },
  review: {
    schemaId: "Review/v1",
    refTemplate: "review/{id}",
    statuses: [
      {
        field: "verdict",
        words: ["approved", "changes_requested", "dismissed"],
      },
    ],
    actions: [],
  },
  "runtime-session": {
    schemaId: "runtime-session/v1",
    refTemplate: "runtime-session/{id}",
    statuses: [
      {
        field: "liveness",
        words: ["live", "stale", "unknown", "exited"],
      },
      {
        field: "outcome",
        words: ["succeeded", "failed", "unknown", "cancelled"],
      },
      {
        field: "semanticState",
        words: ["running", "succeeded", "failed", "cancelled", "ended-indeterminate", "unavailable"],
      },
    ],
    actions: [
      "runtime_session_started",
      "runtime_session_provider_bound",
      "runtime_session_task_bound",
      "runtime_session_liveness_changed",
      "runtime_session_cancelled",
      "runtime_session_exited",
      "runtime_session_outcome_observed",
    ],
  },
  schedule: {
    schemaId: "Schedule/v1",
    refTemplate: "schedule/{id}",
    statuses: [
      {
        field: "state",
        words: ["armed", "paused"],
      },
      {
        field: "status.lastRun.outcome",
        words: ["succeeded", "failed", "unknown", "cancelled"],
      },
    ],
    actions: [
      "create",
      "update",
      "delete",
      "enable",
      "disable",
      "run-now",
      "claim",
      "link",
      "record-missed",
      "settle",
      "list",
      "runs",
      "show",
    ],
  },
  settings: {
    schemaId: "SettingsRepository/v1",
    refTemplate: "settings/{id}",
    statuses: [],
    actions: ["read", "update"],
  },
  squad: {
    schemaId: "squad-declaration/v1",
    refTemplate: "squad/{id}",
    statuses: [],
    actions: ["install", "validate", "list", "inspect", "run", "status", "cancel"],
  },
  task: {
    schemaId: "task-frontmatter",
    refTemplate: "task/{id}",
    statuses: [
      {
        field: "lifecycle.status",
        words: ["planned", "active", "blocked", "in_review", "done", "cancelled"],
      },
    ],
    actions: [
      "start",
      "submit",
      "review",
      "complete",
      "release",
      "amend",
      "archive",
      "supersede",
      "delete",
      "reopen",
      "contract-migrate",
    ],
  },
} as const satisfies Readonly<Record<string, EntityKernelContract>>);

/** Relation 的类型词表:kernel `relationTypes`,不是 statusVocabulary,所以单独投影。 */
export const RELATION_TYPE_WORDS: readonly string[] = Object.freeze([
  "supports",
  "supersedes",
  "refines",
  "narrows",
  "derives",
  "blocks",
  "relates",
  "implements",
  "depends-on",
  "produces",
  "evidences",
  "evidenced-by",
  "refuted-by",
  "invalidated-by",
  "supersedes-fact",
  "executes",
  "reviews",
  "owns",
  "dispatches",
  "authorizes",
]);
// entity-kind-contract:generated:end

/** kernel 半:登记过的 kind 从生成区块取;目录层实体(preset/adapter)自带。 */
const kernelContract = (kind: keyof typeof KERNEL_ENTITY_CONTRACT): EntityKernelContract =>
  KERNEL_ENTITY_CONTRACT[kind];

/**
 * Fact Type 受控词表(dec_2935057783CD5D56E9F287AE4D CH1-CH3):
 * 词表值来自 fact_domain_type 投影读面。这里仅保留裁决锚,不保存第二份词表。
 */
export const FACT_TYPE_VOCABULARY = Object.freeze({
  decisionId: "dec_2935057783CD5D56E9F287AE4D",
});

const taskDoc: EntityKindDoc = {
  kind: "task",
  ...kernelContract("task"),
  storage: "tasks/ 任务包目录(frontmatter + 包内文档)",
  definition:
    "工作包:做什么、现在什么状态。最小派工单位——被创建、被认领(execution 租约)、被提交、被复核,直到完成或取消。",
  fields: [
    field("task_id", true, "string", "稳定 ID;canonical 引用形 task/{task_id}。"),
    field("title", true, "string", "一句话标题,看板/议程/列表的主显示。"),
    field("lifecycle", true, "object", "生命周期绑定:engine、状态、外部追踪 ref/url 与绑定指纹。"),
    field("packageDisposition", true, "enum", "包处置:active / archived / tombstoned。"),
    field("workKind", false, "enum", "工作形状:feat / fix / refactor / docs / test / chore。"),
    field("riskTier", false, "enum", "风险档:low / medium / high。"),
    field("urgency", false, "enum", "紧迫度:low / medium / high。"),
    field("vertical", true, "string", "所属垂直领域(如 software/coding)。"),
    field("preset", true, "string", "生成本包的 preset(脚手架与流程契约来源)。"),
    field("provenance", true, "array", "绑定记录:哪个 runtime 的哪个 session 在何时绑定。"),
    field("parent", false, "string", "父任务 ID;任务树的归属边。"),
    field("createdBy", false, "object", "创建者 name/email。"),
    field("profile", false, "string", "任务 profile(preset 内的档位选择)。"),
  ],
  nestedFields: noNested,
  edges: [
    { type: "derives", sourceKind: "decision", targetKind: "task" },
    { type: "relates", sourceKind: "decision", targetKind: "task" },
    { type: "implements", sourceKind: "task", targetKind: "decision" },
    { type: "depends-on", sourceKind: "task", targetKind: "task" },
    { type: "relates", sourceKind: "task", targetKind: "task" },
    { type: "produces", sourceKind: "task", targetKind: "fact" },
    { type: "evidences", sourceKind: "task", targetKind: "fact" },
    { type: "executes", sourceKind: "execution", targetKind: "task" },
    { type: "executes", sourceKind: "runtime-session", targetKind: "task" },
  ],
  guiEntry: { view: "board", note: "看板 / 议程 / 列表;详情从任务行进入" },
  liveCount: "tasks",
};

const decisionDoc: EntityKindDoc = {
  kind: "decision",
  ...kernelContract("decision"),
  storage: "decisions/decision-dec_<id>/ 包(人话正文 + 事件流)",
  definition:
    "承重选择:为什么这么做。一个问题、被选中的方案(CH)与被否的方案(RJ);经裁定同意进入 in_effect 后约束后续实现。",
  fields: [
    field("decisionId", true, "string", "稳定 ID(dec_ 前缀);锚点可下沉到 claim:decision/{id}/{claimId}。"),
    field("type", true, "enum", "事件类型:proposal / accept / reject / defer / retire / claim / relation …"),
    field("actor", true, "object", "谁裁决:principal(人)+ 可选 executor(agent)。"),
    field("occurredAt", true, "string", "事件时间。"),
    field("payload", true, "object", "事件载荷:proposal 载荷见下,accept 载荷附裁定回执。"),
  ],
  nestedFields: [
    {
      container: "payload(proposal)",
      fields: [
        field("title", true, "string", "一句话标题。"),
        field("question", true, "string", "被裁决的问题本身。"),
        field("riskTier", true, "enum", "风险档:low / medium / high。"),
        field("urgency", true, "enum", "紧迫度:low / medium / high。"),
        field("decisionClass", true, "enum", "ordinary(一次性)/ standing_policy(常设政策)。"),
        field("appliesTo", true, "object", "作用面:modules 与 productLines。"),
        field("chosen", true, "array", "被选中的方案;每条 CH 可带 rationale。"),
        field("rejected", true, "array", "被否的方案;每条 RJ 必须写 whyNot。"),
        field("claims", true, "array", "主张;loadBearing 的主张需要事实佐证(coverage)。"),
        field("body", true, "string", "人话正文(背景→权衡→结论),markdown 可替换。"),
      ],
    },
    {
      container: "payload(accept)",
      fields: [
        field("rationale", true, "string", "裁定理由。"),
        field("judgmentConsent", true, "object", "裁定同意回执:谁在何时把状态裁到哪一档(带机器摘要)。"),
      ],
    },
  ],
  edges: [
    { type: "supersedes", sourceKind: "decision", targetKind: "decision" },
    { type: "refines", sourceKind: "decision", targetKind: "decision" },
    { type: "narrows", sourceKind: "decision", targetKind: "decision" },
    { type: "relates", sourceKind: "decision", targetKind: "decision" },
    { type: "derives", sourceKind: "decision", targetKind: "decision" },
    { type: "supports", sourceKind: "decision", targetKind: "decision" },
    { type: "blocks", sourceKind: "decision", targetKind: "decision" },
    { type: "derives", sourceKind: "decision", targetKind: "task" },
    { type: "relates", sourceKind: "decision", targetKind: "task" },
    { type: "implements", sourceKind: "task", targetKind: "decision" },
    { type: "evidenced-by", sourceKind: "decision", targetKind: "fact" },
    { type: "refuted-by", sourceKind: "decision", targetKind: "fact" },
  ],
  guiEntry: { view: "decisions", note: "决策批准 / 决策池;详情从决策行进入" },
  liveCount: "decisions",
};

const factDoc: EntityKindDoc = {
  kind: "fact",
  ...kernelContract("fact"),
  storage: "facts/F-<id>.md(机器写手策略 typed-machine-writer/v1)",
  definition:
    "可复核观察:测到什么、在哪测的、怎么复现。append-only——事件本身不可改,推翻一条观察用新事实取代它,不删除旧的。",
  fields: [
    field("factId", true, "string", "稳定 ID(F- 加 8 位 Crockford Base32 字符,去 I/L/O/U);引用形 fact/{factId}。"),
    field("taskId", false, "string", "归属任务;收口前至少要有一条真实 fact。"),
    field("type", true, "const", "事件类型,当前只有 fact_recorded。"),
    field("actor", true, "object", "谁记的:principal(人)+ 可选 executor(agent)。"),
    field("occurredAt", true, "string", "观察发生时间。"),
    field("payload", true, "object", "观察本体,见下。"),
  ],
  nestedFields: [
    {
      container: "payload",
      fields: [
        field("statement", true, "string", "观察陈述:测到什么,不是做了什么。"),
        field("evidenceSource", true, "string", "证据来源:路径 / URL / 命令。"),
        field("observedAt", true, "string", "观察时点(与记录时点区分)。"),
        field("confidence", true, "enum", "置信度:low / medium / high。"),
        field("memoryClass", true, "enum", "记忆类别:semantic / episodic / procedural。"),
        field(
          "memoryTags",
          true,
          "array",
          "受控标签:episode / procedural / tool_memory / pattern / task_skill / abstract_rule / other。",
        ),
        field("provenance", true, "array", "绑定记录:runtime / sessionId / boundAt。"),
        field("supersedes", false, "object", "取代哪条事实及理由(fact/F-<id> + rationale)。"),
        field(
          "domainTypes",
          false,
          "array",
          "领域类型(可多值):这条事实讲什么,如 架构 / bug / 技术栈。每个值必须是已登记的受控词,未登记会被拒。只能经 reclassify 改动。",
        ),
        field(
          "registersDomainType",
          false,
          "string",
          "本次记录顺带登记一个新的领域类型词(受控词表的唯一增长入口,与 domainTypes 互斥,不可变)。",
        ),
        field(
          "reclassificationRationale",
          false,
          "string",
          "重新归类的理由(仅 fact_reclassified 事件携带,1–199 字,不可变审计证据)。",
        ),
      ],
    },
  ],
  edges: [
    { type: "produces", sourceKind: "task", targetKind: "fact" },
    { type: "evidences", sourceKind: "task", targetKind: "fact" },
    { type: "evidenced-by", sourceKind: "decision", targetKind: "fact" },
    { type: "refuted-by", sourceKind: "decision", targetKind: "fact" },
    { type: "supersedes-fact", sourceKind: "fact", targetKind: "fact" },
  ],
  guiEntry: { view: "graph", note: "关系图与 Task 详情·证据页签" },
  liveCount: null,
};

const relationDoc: EntityKindDoc = {
  kind: "relation",
  ...kernelContract("relation"),
  // 关系动词是 kernel 的 relationTypes,不在 statusVocabulary 里,所以显式并进词表区一起展示。
  statuses: [{ field: "type", words: RELATION_TYPE_WORDS }, ...kernelContract("relation").statuses],
  storage: "台账边表(canonical 事件)",
  definition:
    "三元语之间的边:把 task / decision / fact 连成语义网。边是一等实体,有方向、强度、出处与状态;" +
    "方向注册表规定哪种 (源, 动词, 目标) 三元组是合法的。边本身也可以作为关系端点——" +
    "任何已登记的 kind 都能与一条边相关联,用来给边加注说明。",
  fields: [
    field("id", true, "string", "稳定 ID(rel_ 加 16 位十六进制)。"),
    field("relationEndpoint", true, "object", "两端的 kind 与 ref;方向注册表按它判定三元组是否合法。"),
    field("source", true, "string", "源端 canonical 引用。"),
    field("target", true, "string", "目标端 canonical 引用。"),
    field("type", true, "enum", "关系动词(受控词表,见状态词表区)。"),
    field("strength", true, "enum", "strong / weak。"),
    field("direction", true, "enum", "directed / undirected。"),
    field("origin", true, "enum", "declared / imported_snapshot / generated / inferred。"),
    field("rationale", true, "string", "为什么建这条边。"),
    field("state", true, "enum", "active / edge_retired / deleted。"),
  ],
  nestedFields: noNested,
  edges: [],
  guiEntry: { view: "graph", note: "关系图;边即图上的连线" },
  liveCount: null,
};

const executionDoc: EntityKindDoc = {
  kind: "execution",
  ...kernelContract("execution"),
  storage: "task 生命周期事件流(不在独立包目录)",
  definition:
    "task 的一次执行尝试:认领租约、工作、提交、收口。一个 task 可以有多轮 execution(iteration 递增);同一时刻租约只归一个执行者。",
  fields: [
    field("executionId", true, "string", "本轮执行的稳定 ID。"),
    field("taskId", true, "string", "所属任务。"),
    field("nodeId", true, "const", "执行节点;本地实现节点为 implementation。"),
    field("iteration", true, "integer", "第几轮尝试。"),
    field("state", true, "enum", "见状态词表。"),
    field("actor", true, "object", "执行者(人 principal 或 agent executor)。"),
    field("claimedAt", true, "string", "租约取得时间。"),
    field("submittedAt", true, "string", "提交时间(未提交为 null)。"),
    field("submission", true, "object", "提交物:改动清单 / 测试证据 / 收口报告。"),
  ],
  nestedFields: noNested,
  edges: [
    { type: "executes", sourceKind: "execution", targetKind: "task" },
    { type: "reviews", sourceKind: "review", targetKind: "execution" },
    { type: "authorizes", sourceKind: "policy", targetKind: "execution" },
  ],
  guiEntry: { view: "sessions", note: "会话页与 Task 详情;执行链随派工归属" },
  liveCount: null,
};

const reviewDoc: EntityKindDoc = {
  kind: "review",
  ...kernelContract("review"),
  storage: "task 生命周期事件流(review_recorded / review_consent_recorded)",
  definition: "对一次 execution 提交的复核判断:通过、要求修改或驳回;带证据核对清单与内容摘要。",
  fields: [
    field("reviewId", true, "string", "复核记录稳定 ID。"),
    field("taskId", true, "string", "所属任务。"),
    field("executionId", true, "string", "被复核的执行。"),
    field("verdict", true, "enum", "见状态词表。"),
    field("reason", true, "string", "判定理由。"),
    field("evidenceChecked", true, "array", "核对过的证据项。"),
    field("commitSha", true, "string", "被复核的提交(40 位 sha)。"),
    field("contentDigest", true, "string", "内容摘要(sha256)。"),
  ],
  nestedFields: noNested,
  edges: [{ type: "reviews", sourceKind: "review", targetKind: "execution" }],
  guiEntry: null,
  liveCount: null,
};

const runtimeSessionDoc: EntityKindDoc = {
  kind: "runtime-session",
  ...kernelContract("runtime-session"),
  storage: "agent 运行时事件流(runtime_session_*)",
  definition:
    "provider 侧的一次真实会话(claude / codex / …)。存活与结果分开记录:semanticState 是对两者的派生判断,不采信单边自报。",
  fields: [
    field("runtimeSessionId", true, "string", "会话稳定 ID(runtime_ 前缀)。"),
    field("taskBindings", true, "array", "认证交接后本会话执行的任务绑定。"),
    field("liveness", true, "enum", "进程存活:见状态词表。"),
    field("outcome", true, "enum", "provider 结果;未结算为 null。"),
    field("semanticState", true, "enum", "派生语义态:liveness × outcome 的判定。"),
  ],
  nestedFields: noNested,
  edges: [
    { type: "executes", sourceKind: "runtime-session", targetKind: "task" },
    { type: "dispatches", sourceKind: "agent", targetKind: "runtime-session" },
  ],
  guiEntry: { view: "sessions", note: "会话页;单会话段与派工链" },
  liveCount: null,
};

const agentDoc: EntityKindDoc = {
  kind: "agent",
  ...kernelContract("agent"),
  storage: "agents/{id}.json 声明文件",
  definition:
    "执行者身份声明:这个身份用什么运行时、什么提示词纪律、什么模型与技能。角色只是注入的责任,不是模型能力白名单。",
  fields: [
    field("id", true, "string", "稳定身份 slug。"),
    field("name", true, "string", "显示名。"),
    field("instructions", true, "string", "身份指令(提示词纪律)。"),
    field("runtime_type", true, "string", "要求的运行时种类(claude / codex / …)。"),
    field("role", false, "enum", "worker / commander。"),
    field("model", false, "string", "模型选择。"),
    field("skills", false, "array", "技能引用:{id, path}。"),
    field("prompts", false, "array", "提示词引用。"),
    field("fallback", false, "object", "provider 故障时的候选链与退避策略。"),
  ],
  nestedFields: noNested,
  edges: [{ type: "dispatches", sourceKind: "agent", targetKind: "runtime-session" }],
  guiEntry: { view: "agentSquad", note: "Agent · 含 Squad 页" },
  liveCount: "agents",
};

const squadDoc: EntityKindDoc = {
  kind: "squad",
  ...kernelContract("squad"),
  storage: "squads/{id}.json 声明文件",
  definition: "多 agent 编排:一个 leader 带若干 worker,整轮运行受 leaderTurnBudget 约束(规划轮 + 全部回调与重试轮)。",
  fields: [
    field("id", true, "string", "稳定身份 slug。"),
    field("name", true, "string", "显示名。"),
    field("leader", true, "string", "leader agent ID。"),
    field("workers", true, "array", "worker agent ID 列表。"),
    field("leaderTurnBudget", true, "integer", "整轮运行的轮次上限。"),
    field("roster", true, "string", "花名册引用。"),
  ],
  nestedFields: noNested,
  edges: [],
  guiEntry: { view: "agentSquad", note: "Agent · 含 Squad 页(小队编排面)" },
  liveCount: "squads",
};

const scheduleDoc: EntityKindDoc = {
  kind: "schedule",
  ...kernelContract("schedule"),
  storage: "schedule 事件流(定义 / 运行两类)",
  definition:
    "定时触发:按间隔或 cron 周期性派一次 agent 或 squad 运行。一次触发(occurrence)只被一个节点认领,产出归属该次运行而不是共享任务。",
  fields: [
    field("scheduleId", true, "string", "计划稳定 ID。"),
    field("name", true, "string", "显示名。"),
    field("state", true, "enum", "armed / paused。"),
    field("mode", true, "enum", "detect(只观察)/ remediate(可修复)。"),
    field("spec", true, "object", "规格:trigger(interval 或 cron)、target(agent 或 squad)与 mission。"),
    field("status", true, "object", "运行面:上次运行、活跃运行、错过计数与原因。"),
  ],
  nestedFields: noNested,
  edges: [],
  guiEntry: { view: "schedules", note: "定时计划页(hub:概览 / 运行 / 编辑)" },
  liveCount: "schedules",
};

const presetDoc: EntityKindDoc = {
  kind: "preset",
  schemaId: null,
  refTemplate: null,
  storage: "preset 包(bundled / user 两层,user 可遮蔽 bundled)",
  definition:
    "垂直领域的任务包脚手架与流程契约:文档模板、entrypoint、校验规则。任务包由 preset 生成,GUI 不读文件系统,目录读面是 resolver 单一权威。",
  fields: [
    field("id", true, "string", "preset ID。"),
    field("title", true, "string", "显示名。"),
    field("verticalId", true, "string", "所属垂直领域。"),
    field("sourceKind", true, "enum", "bundled / user / user-shadow(用户层遮蔽内置)。"),
    field("validity", true, "enum", "valid / unavailable / blocked。"),
    field("version", false, "string", "版本;未解析为 null。"),
    field("entrypoints", true, "array", "能力入口。"),
  ],
  nestedFields: noNested,
  statuses: [],
  edges: [],
  actions: [],
  guiEntry: { view: "presets", note: "预设 / 垂直领域(目录 + 详情)" },
  liveCount: "presets",
};

const policyDoc: EntityKindDoc = {
  kind: "policy",
  ...kernelContract("policy"),
  storage: "策略声明(predicate + action 规则)",
  definition: "写入面的授权规则:哪些动作在什么谓词下放行。执行授权走 policy → execution 边。",
  fields: [
    field("id", true, "string", "稳定身份 slug。"),
    field("version", true, "integer", "单调递增的版本号。"),
    field("predicates", true, "array", "本策略可用的内核谓词(判据)。"),
    field("actions", true, "array", "受控动作清单。"),
    field("rules", false, "array", "谓词 → 动作的放行规则。"),
  ],
  nestedFields: noNested,
  edges: [{ type: "authorizes", sourceKind: "policy", targetKind: "execution" }],
  guiEntry: null,
  liveCount: null,
};

const settingsDoc: EntityKindDoc = {
  kind: "settings",
  ...kernelContract("settings"),
  storage: "settings 事件流(当前值是投影)",
  definition: "仓库级默认值:默认垂直领域、默认 preset 与 profile、locale、脚手架选择。",
  fields: [
    field("settingsId", true, "const", "固定为 repository(每仓一份)。"),
    field("defaultVertical", true, "string", "默认垂直领域。"),
    field("defaultPreset", true, "string", "默认 preset。"),
    field("defaultProfile", true, "string", "默认 profile。"),
    field("scaffolds", true, "object", "任务 / 仓库脚手架选择。"),
  ],
  nestedFields: noNested,
  edges: [],
  guiEntry: { view: "settings", note: "设置页(可写)" },
  liveCount: null,
};

const personDoc: EntityKindDoc = {
  kind: "person",
  ...kernelContract("person"),
  storage: "people 花名册事件流",
  definition: "人:身份、角色与凭据。principal 引用(personId)由此登记;决策与执行 actor 都指向人。",
  fields: [
    field("personId", true, "string", "人的稳定 ID。"),
    field("displayName", true, "string", "显示名。"),
    field("roles", true, "array", "角色清单。"),
    field("credentials", true, "array", "凭据:kind / issuer / subject。"),
    field("disabled", false, "boolean", "是否停用。"),
  ],
  nestedFields: noNested,
  edges: [],
  guiEntry: null,
  liveCount: null,
};

const adapterDoc: EntityKindDoc = {
  kind: "adapter",
  schemaId: null,
  refTemplate: null,
  storage: "adapter 注册表(引擎接入面)",
  definition:
    "外部引擎适配器:claude / codex / opencode 等引擎的接入与可写性。外部引擎管理的任务 GUI 只读,状态去对应系统改。",
  fields: [
    field("adapterId", true, "string", "引擎 ID。"),
    field("capabilities", true, "array", "能力清单。"),
    field("writability", true, "enum", "read-only / read-write / unknown。"),
    field("registered", true, "const", "是否已注册。"),
  ],
  nestedFields: noNested,
  statuses: [],
  edges: [],
  actions: [],
  guiEntry: { view: "adapters", note: "引擎适配器页" },
  liveCount: "adapters",
};

export const ENTITY_DOC_GROUPS: readonly EntityDocGroup[] = [
  {
    id: "triad",
    title: "三元语",
    summary: "内核的三个一等实体与把它们连起来的边:task 做什么、decision 为什么、fact 看到了什么。",
    docs: [taskDoc, decisionDoc, factDoc, relationDoc],
  },
  {
    id: "runtime",
    title: "执行与运行时",
    summary: "工作怎么被执行、复核、会话化与编排。",
    docs: [executionDoc, reviewDoc, runtimeSessionDoc, agentDoc, squadDoc, scheduleDoc],
  },
  {
    id: "catalog",
    title: "目录与配置",
    summary: "脚手架、授权、默认值、人员与引擎接入面。",
    docs: [presetDoc, policyDoc, settingsDoc, personDoc, adapterDoc],
  },
];

export const ENTITY_DOC_BY_KIND: ReadonlyMap<string, EntityKindDoc> = new Map(
  ENTITY_DOC_GROUPS.flatMap((group) => group.docs).map((doc) => [doc.kind, doc]),
);

export const entityDocKinds = (): readonly string[] => [...ENTITY_DOC_BY_KIND.keys()];
