/* 移植自 operator-gui-v2 原型：项目 / 任务 / 关系 mock 数据 */
import type {
  TaskRow,
  DocEntry,
  Project,
  RelationEdge,
} from "./types";

export const MOCK_PROJECTS: Project[] = [
  {
    id: "harness-anything",
    name: "harness-anything",
    path: "~/Projects/coding-agent-harness/harness-anything",
    preset: "harness-rewrite",
    engines: ["local", "multica", "github", "linear"],
    watermarkAt: "2026-06-12T10:02:00",
  },
  {
    id: "coding-agent-harness",
    name: "coding-agent-harness",
    path: "~/Projects/coding-agent-harness",
    preset: "docs-default",
    engines: ["local", "github"],
    watermarkAt: "2026-06-12T09:40:00",
  },
  {
    id: "rag-pipeline-svc",
    name: "rag-pipeline-svc",
    path: "~/Projects/rag-pipeline-svc",
    preset: "engineering-default",
    engines: ["local", "linear"],
    watermarkAt: "2026-06-11T18:25:00",
  },
];

/* ---------------- 文档骨架 ---------------- */

const FULL_PACK: Omit<DocEntry, "present">[] = [
  { path: "contract.md", title: "任务契约", group: "必读", required: true },
  { path: "task_flow.md", title: "阶段流程", group: "必读", required: true },
  { path: "plan/milestones.md", title: "里程碑计划", group: "计划", required: false },
  { path: "plan/strategy.md", title: "实施策略", group: "计划", required: false },
  { path: "design/decisions.md", title: "设计决策", group: "设计", required: false },
  { path: "design/visual-map.md", title: "可视化地图", group: "设计", required: false },
  { path: "progress/log.md", title: "进度记录", group: "进度", required: false },
  { path: "review/walkthrough.md", title: "Walkthrough", group: "收口", required: true },
  { path: "review/lessons.md", title: "经验沉淀", group: "收口", required: false },
  { path: "evidence/run-log.md", title: "执行证据", group: "证据", required: true },
];

/** missing 传入缺失文档的 path 列表 */
const docs = (missing: string[] = []): DocEntry[] =>
  FULL_PACK.map((d) => ({ ...d, present: !missing.includes(d.path) }));

/* ---------------- 任务 ---------------- */

type TaskSeed = Partial<TaskRow> &
  Pick<TaskRow, "taskId" | "title" | "coordinationStatus" | "module">;

const T = (s: TaskSeed): TaskRow => ({
  projectId: "harness-anything",
  rawStatus: s.coordinationStatus as string,
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "not_required",
  engine: "local",
  source: "local-document",
  lastKnownAt: "2026-06-12T09:00:00",
  gates: [],
  docs: docs(),
  ...s,
});

export const MOCK_TASKS: TaskRow[] = [
  /* ===== harness-anything · kernel ===== */
  T({
    taskId: "KER-101",
    title: "WriteCoordinator 串行写入与冲突重建",
    coordinationStatus: "active",
    module: "kernel",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-06-12T09:42:00",
    gates: [
      { name: "schema-check", ok: true },
      { name: "import-boundary", ok: true },
    ],
    docs: docs(["review/walkthrough.md", "evidence/run-log.md"]),
  }),
  T({
    taskId: "KER-102",
    title: "三端口 Schema 契约与校验管线",
    coordinationStatus: "in_review",
    module: "kernel",
    closeoutReadiness: "ready",
    waitingSince: "2026-06-12T08:15:00",
    lastKnownAt: "2026-06-12T08:15:00",
    gates: [
      { name: "materialization", ok: true },
      { name: "check", ok: true },
    ],
  }),
  T({
    taskId: "KER-108",
    title: "Relation 实体与 provenance 字段",
    coordinationStatus: "planned",
    module: "kernel",
    docs: docs(["design/visual-map.md", "progress/log.md", "review/walkthrough.md", "review/lessons.md", "evidence/run-log.md"]),
  }),
  T({
    taskId: "KER-109",
    title: "WriteCoordinator 锁竞争压测",
    coordinationStatus: "blocked",
    module: "kernel",
    closeoutReadiness: "missing",
    gates: [{ name: "stress-bench", ok: false, detail: "p99 写延迟超阈值" }],
    docs: docs(["review/walkthrough.md", "evidence/run-log.md"]),
  }),
  /* ===== harness-anything · store ===== */
  T({
    taskId: "KER-103",
    title: "ArtifactStore 目录布局与 scaffold 生成器",
    coordinationStatus: "planned",
    module: "store",
    lastKnownAt: "2026-06-11T17:20:00",
    docs: docs(["plan/strategy.md", "design/visual-map.md", "review/walkthrough.md", "evidence/run-log.md"]),
  }),
  T({
    taskId: "KER-107",
    title: "投影 watermark 与增量刷新",
    coordinationStatus: "active",
    module: "store",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-06-12T07:30:00",
  }),
  T({
    taskId: "STO-210",
    title: "ArtifactStore 路径遍历防护",
    coordinationStatus: "in_review",
    module: "store",
    closeoutReadiness: "ready",
    waitingSince: "2026-06-11T15:00:00",
    lastKnownAt: "2026-06-11T15:00:00",
    gates: [
      { name: "materialization", ok: true },
      { name: "security-check", ok: true },
    ],
  }),
  T({
    taskId: "STO-211",
    title: "tombstone GC 策略",
    coordinationStatus: "planned",
    module: "store",
    docs: docs(["plan/milestones.md", "design/decisions.md", "review/walkthrough.md", "evidence/run-log.md"]),
  }),
  /* ===== harness-anything · cli ===== */
  T({
    taskId: "KER-104",
    title: "投影重建命令 governance rebuild",
    coordinationStatus: "done",
    module: "cli",
    closeoutReadiness: "passed",
    lastKnownAt: "2026-06-10T16:03:00",
  }),
  T({
    taskId: "CLI-310",
    title: "harness check 增量快照命令",
    coordinationStatus: "active",
    module: "cli",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-06-12T08:50:00",
  }),
  T({
    taskId: "CLI-311",
    title: "harness init 模板物化",
    coordinationStatus: "done",
    module: "cli",
    closeoutReadiness: "passed",
    lastKnownAt: "2026-06-09T14:12:00",
  }),
  /* ===== harness-anything · gui ===== */
  T({
    taskId: "KER-105",
    title: "旧版 dashboard 字段清理",
    coordinationStatus: "cancelled",
    module: "gui",
    packageDisposition: "archived",
    lastKnownAt: "2026-06-08T11:30:00",
  }),
  T({
    taskId: "GUI-401",
    title: "七视图导航壳与主题系统",
    coordinationStatus: "active",
    module: "gui",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-06-12T10:01:00",
  }),
  T({
    taskId: "GUI-402",
    title: "审阅工作台批量操作",
    coordinationStatus: "planned",
    module: "gui",
    docs: docs(["design/visual-map.md", "review/walkthrough.md", "evidence/run-log.md"]),
  }),
  T({
    taskId: "GUI-403",
    title: "Electron 安全合同 CSP 落地",
    coordinationStatus: "blocked",
    module: "gui",
    closeoutReadiness: "missing",
    gates: [{ name: "security-contract", ok: false, detail: "CSP 白名单未冻结" }],
    docs: docs(["review/walkthrough.md", "evidence/run-log.md"]),
  }),
  /* ===== harness-anything · adapters ===== */
  T({
    taskId: "FAI-37",
    title: "Task binding schema 与三轴投影",
    coordinationStatus: "blocked",
    rawStatus: "waiting_local_directory",
    module: "adapters",
    engine: "multica",
    source: "snapshot-cache",
    freshness: "stale-but-usable",
    closeoutReadiness: "missing",
    lastKnownAt: "2026-06-12T07:55:00",
    docs: docs(["review/walkthrough.md", "evidence/run-log.md"]),
  }),
  T({
    taskId: "GH-2214",
    title: "GitHub Issues adapter 状态映射表",
    coordinationStatus: "active",
    rawStatus: "open:in-progress",
    module: "adapters",
    engine: "github",
    source: "external-engine",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-06-12T09:10:00",
  }),
  T({
    taskId: "LIN-88",
    title: "Linear adapter 增量快照轮询",
    coordinationStatus: "unknown",
    rawStatus: "triage_hold",
    module: "adapters",
    engine: "linear",
    source: "snapshot-cache",
    freshness: "stale-but-usable",
    closeoutReadiness: "missing",
    lastKnownAt: "2026-06-11T22:40:00",
    docs: docs(["review/walkthrough.md", "evidence/run-log.md"]),
  }),
  T({
    taskId: "LIN-92",
    title: "Closeout note 发布管道",
    coordinationStatus: "in_review",
    rawStatus: "In Review",
    module: "adapters",
    engine: "linear",
    source: "snapshot-cache",
    freshness: "unavailable-no-cache",
    closeoutReadiness: "ready",
    waitingSince: "2026-06-10T19:12:00",
    lastKnownAt: "2026-06-10T19:12:00",
    gates: [{ name: "snapshot-fresh", ok: false, detail: "快照缓存不可用" }],
  }),
  T({
    taskId: "ADP-501",
    title: "GitHub 状态映射表补全",
    coordinationStatus: "in_review",
    rawStatus: "open:review",
    module: "adapters",
    engine: "github",
    source: "external-engine",
    closeoutReadiness: "ready",
    waitingSince: "2026-06-12T06:40:00",
    lastKnownAt: "2026-06-12T09:30:00",
    gates: [{ name: "check", ok: true }],
  }),
  T({
    taskId: "ADP-502",
    title: "Multica snapshot 缓存层",
    coordinationStatus: "done",
    rawStatus: "done",
    module: "adapters",
    engine: "multica",
    source: "snapshot-cache",
    closeoutReadiness: "passed",
    lastKnownAt: "2026-06-09T20:05:00",
  }),
  /* ===== harness-anything · ci ===== */
  T({
    taskId: "KER-106",
    title: "import boundary 测试覆盖 GUI 包",
    coordinationStatus: "in_review",
    module: "ci",
    closeoutReadiness: "ready",
    waitingSince: "2026-06-12T09:58:00",
    lastKnownAt: "2026-06-12T09:58:00",
    gates: [
      { name: "materialization", ok: true },
      { name: "check", ok: true },
    ],
  }),
  T({
    taskId: "CI-601",
    title: "import-boundary 测试矩阵",
    coordinationStatus: "active",
    module: "ci",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-06-12T09:20:00",
  }),
  T({
    taskId: "CI-602",
    title: "GUI 包 e2e 烟测",
    coordinationStatus: "in_review",
    module: "ci",
    closeoutReadiness: "failed",
    lastKnownAt: "2026-06-11T16:45:00",
    gates: [{ name: "e2e", ok: false, detail: "3 条用例超时" }],
  }),

  /* ===== coding-agent-harness ===== */
  T({
    taskId: "DOC-11",
    title: "kernel-rewrite 文档导航重组",
    coordinationStatus: "active",
    module: "docs",
    projectId: "coding-agent-harness",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-06-12T09:35:00",
  }),
  T({
    taskId: "DOC-12",
    title: "GUI spec 七视图修订",
    coordinationStatus: "in_review",
    module: "docs",
    projectId: "coding-agent-harness",
    closeoutReadiness: "ready",
    waitingSince: "2026-06-12T09:55:00",
    lastKnownAt: "2026-06-12T09:55:00",
    gates: [{ name: "materialization", ok: true }],
  }),
  T({
    taskId: "DOC-13",
    title: "adapter PRD 模板统一",
    coordinationStatus: "planned",
    module: "docs",
    projectId: "coding-agent-harness",
    docs: docs(["design/decisions.md", "review/walkthrough.md", "evidence/run-log.md"]),
  }),
  T({
    taskId: "TPL-21",
    title: "dashboard 模板抽离",
    coordinationStatus: "done",
    module: "templates",
    projectId: "coding-agent-harness",
    closeoutReadiness: "passed",
    lastKnownAt: "2026-06-08T15:40:00",
  }),
  T({
    taskId: "TPL-22",
    title: "preset 双语模板镜像",
    coordinationStatus: "blocked",
    module: "templates",
    projectId: "coding-agent-harness",
    closeoutReadiness: "missing",
    docs: docs(["review/walkthrough.md", "evidence/run-log.md"]),
    lastKnownAt: "2026-06-11T11:00:00",
  }),
  T({
    taskId: "DSH-31",
    title: "legacy dashboard 退役清单",
    coordinationStatus: "cancelled",
    module: "dashboard",
    projectId: "coding-agent-harness",
    packageDisposition: "archived",
    lastKnownAt: "2026-06-07T10:00:00",
  }),
  T({
    taskId: "DSH-32",
    title: "issue 同步脚本迁移",
    coordinationStatus: "active",
    rawStatus: "open:in-progress",
    module: "dashboard",
    projectId: "coding-agent-harness",
    engine: "github",
    source: "external-engine",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-06-12T08:05:00",
  }),

  /* ===== rag-pipeline-svc ===== */
  T({
    taskId: "RAG-1",
    title: "增量摄取管线",
    coordinationStatus: "active",
    module: "ingest",
    projectId: "rag-pipeline-svc",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-06-11T17:55:00",
  }),
  T({
    taskId: "RAG-2",
    title: "混合检索权重调参",
    coordinationStatus: "planned",
    module: "retrieval",
    projectId: "rag-pipeline-svc",
    docs: docs(["plan/strategy.md", "review/walkthrough.md", "evidence/run-log.md"]),
  }),
  T({
    taskId: "RAG-3",
    title: "重排序 provider 接口",
    coordinationStatus: "in_review",
    rawStatus: "In Review",
    module: "retrieval",
    projectId: "rag-pipeline-svc",
    engine: "linear",
    source: "snapshot-cache",
    freshness: "stale-but-usable",
    closeoutReadiness: "ready",
    waitingSince: "2026-06-11T13:20:00",
    lastKnownAt: "2026-06-11T13:20:00",
    gates: [{ name: "check", ok: true }],
  }),
  T({
    taskId: "RAG-4",
    title: "评测集冻结",
    coordinationStatus: "blocked",
    module: "eval",
    projectId: "rag-pipeline-svc",
    closeoutReadiness: "missing",
    docs: docs(["review/walkthrough.md", "evidence/run-log.md"]),
    lastKnownAt: "2026-06-10T09:30:00",
  }),
  T({
    taskId: "RAG-5",
    title: "离线指标基线",
    coordinationStatus: "done",
    module: "eval",
    projectId: "rag-pipeline-svc",
    closeoutReadiness: "passed",
    lastKnownAt: "2026-06-09T19:00:00",
  }),
  T({
    taskId: "RAG-6",
    title: "队列积压治理",
    coordinationStatus: "unknown",
    rawStatus: "backlog_grooming",
    module: "ingest",
    projectId: "rag-pipeline-svc",
    engine: "linear",
    source: "snapshot-cache",
    freshness: "stale-but-usable",
    closeoutReadiness: "missing",
    lastKnownAt: "2026-06-11T08:15:00",
    docs: docs(["review/walkthrough.md", "evidence/run-log.md"]),
  }),
];

/* ---------------- 任务关系 ---------------- */

export const MOCK_RELATIONS: RelationEdge[] = [
  /* ===== harness-anything：依赖主链 KER-101 → KER-102 → KER-106 ===== */
  { from: "KER-102", to: "KER-101", kind: "depends_on", provenance: "local-document" },
  { from: "KER-106", to: "KER-102", kind: "depends_on", provenance: "local-document" },
  { from: "KER-109", to: "KER-101", kind: "depends_on", provenance: "local-document" },
  /* 父子树：KER-103 拆出 store 两个子任务 */
  { from: "KER-103", to: "STO-210", kind: "parent_of", provenance: "local-document" },
  { from: "KER-103", to: "STO-211", kind: "parent_of", provenance: "local-document" },
  { from: "KER-107", to: "KER-103", kind: "depends_on", provenance: "local-document" },
  /* GUI 链挂在 schema 契约之后 */
  { from: "GUI-401", to: "KER-102", kind: "depends_on", provenance: "local-document" },
  { from: "GUI-402", to: "GUI-401", kind: "depends_on", provenance: "local-document" },
  { from: "GUI-403", to: "KER-106", kind: "references", provenance: "local-document" },
  { from: "CI-602", to: "GUI-401", kind: "depends_on", provenance: "local-document" },
  { from: "CI-601", to: "KER-106", kind: "references", provenance: "local-document" },
  /* 引用关系（不构成依赖） */
  { from: "KER-108", to: "KER-102", kind: "references", provenance: "local-document" },
  /* 外部引擎侧记录的关系：provenance=external-engine */
  { from: "ADP-501", to: "GH-2214", kind: "references", provenance: "external-engine" },
  { from: "FAI-37", to: "KER-101", kind: "depends_on", provenance: "external-engine" },
  { from: "LIN-92", to: "ADP-502", kind: "depends_on", provenance: "external-engine" },
  { from: "LIN-88", to: "LIN-92", kind: "references", provenance: "external-engine" },
  { from: "ADP-502", to: "KER-103", kind: "depends_on", provenance: "local-document" },

  /* ===== coding-agent-harness：文档/模板流水 ===== */
  { from: "DOC-12", to: "DOC-11", kind: "depends_on", provenance: "local-document" },
  { from: "TPL-22", to: "TPL-21", kind: "depends_on", provenance: "local-document" },
  { from: "DOC-13", to: "TPL-21", kind: "references", provenance: "local-document" },
  { from: "DSH-32", to: "DSH-31", kind: "references", provenance: "external-engine" },

  /* ===== rag-pipeline-svc：ingest → retrieval → eval 主链 ===== */
  { from: "RAG-2", to: "RAG-1", kind: "depends_on", provenance: "local-document" },
  { from: "RAG-3", to: "RAG-1", kind: "depends_on", provenance: "local-document" },
  { from: "RAG-4", to: "RAG-3", kind: "depends_on", provenance: "local-document" },
  { from: "RAG-4", to: "RAG-5", kind: "depends_on", provenance: "local-document" },
  { from: "RAG-1", to: "RAG-6", kind: "parent_of", provenance: "external-engine" },
  /* ===== 三元语 relation：decision/task/fact 跨实体边（<entity>/<id> 形式）===== */
  // DEC-101(三元语内核)派生出 task,并 supports 其 evidence fact
  { from: "decision/DEC-101", to: "task/KER-101", kind: "derives", provenance: "local-document", rationale: "三元语内核裁决派生 WriteCoordinator 串行写入实现" },
  { from: "decision/DEC-101/C1", to: "fact/KER-101/F-lesson-drift", kind: "supports", provenance: "local-document", rationale: "lesson 漂移事实证实 loop 闭不上是 task-only 的根因" },
  { from: "decision/DEC-101/C2", to: "fact/KER-106/F-perf-baseline", kind: "supports", provenance: "local-document", rationale: "性能基线证明 fact 内嵌 task 不增加检索负担" },
  // DEC-102 推翻 DEC-100(老的 task-only 假设)
  { from: "decision/DEC-102", to: "decision/DEC-100", kind: "supersedes", provenance: "local-document", rationale: "SQLite 投影方案取代旧的全量 markdown 扫描" },
  // DEC-103 被 DEC-104 推翻 → 已 retired;回流:引用 DEC-103 的 fact 被标记
  { from: "decision/DEC-104", to: "decision/DEC-103", kind: "supersedes", provenance: "local-document", rationale: "承认 PreToolUse 拿不到语义,三层软防御取代硬 hook 强拦" },
  // fact 失效:新测量推翻旧 fact(E49)
  { from: "fact/KER-106/F-perf-v2", to: "fact/KER-106/F-perf-baseline", kind: "invalidated_by", provenance: "local-document", rationale: "重测 450ms 推翻 <200ms 旧基线,测量口径不同" },

  // ===== 收件箱验证用新增 relation:DEC-105/106/107/108 的派生 + 证据 =====
  // DEC-105 派生出 daemon runtime task + evidence fact 支撑
  { from: "decision/DEC-105", to: "task/KER-109", kind: "derives", provenance: "local-document", rationale: "并发模型裁决派生 daemon 锁竞争压测" },
  { from: "decision/DEC-105/CH1", to: "fact/KER-109/F-pty-bench", kind: "supports", provenance: "local-document", rationale: "PTY 基准证明 Effect fiber 调度足以承载流式输出" },
  { from: "decision/DEC-105/C1", to: "fact/KER-101/F-lesson-drift", kind: "supports", provenance: "local-document", rationale: "WriteCoordinator 串行化已是既成事实,无需 worker 池" },
  // DEC-106 派生出 CSP 落地 task + 安全审计 fact
  { from: "decision/DEC-106", to: "task/GUI-403", kind: "derives", provenance: "local-document", rationale: "CSP 裁决派生 Electron 安全合同落地" },
  { from: "decision/DEC-106/CH1", to: "fact/GUI-403/F-csp-audit", kind: "supports", provenance: "local-document", rationale: "安全审计定性 eval 是 RCE 放大器" },
  // DEC-107 派生出看板重构 task + DnD 抖动 fact
  { from: "decision/DEC-107", to: "task/GUI-401", kind: "derives", provenance: "local-document", rationale: "dnd-kit 迁移裁决派生七视图导航壳看板拖拽改造" },
  { from: "decision/DEC-107/CH1", to: "fact/GUI-401/F-dnd-jank", kind: "supports", provenance: "local-document", rationale: "抖动测量证明 HTML5 DnD 在 Firefox+触控板不可救" },
  // DEC-106 推翻一条更早的宽松 CSP 提案(演示 supersede 链)
  { from: "decision/DEC-106", to: "decision/DEC-099", kind: "supersedes", provenance: "local-document", rationale: "早期生产也留 eval 的便利方案被安全审计否决" },

  // Implicit observes edges connecting Tasks to Facts
  { from: "task/KER-101", to: "fact/KER-101/F-lesson-drift", kind: "observes", provenance: "local-document" },
  { from: "task/KER-106", to: "fact/KER-106/F-perf-baseline", kind: "observes", provenance: "local-document" },
  { from: "task/KER-106", to: "fact/KER-106/F-perf-v2", kind: "observes", provenance: "local-document" },
  { from: "task/STO-210", to: "fact/STO-210/F-journal-idem", kind: "observes", provenance: "local-document" },
  { from: "task/KER-109", to: "fact/KER-109/F-pty-bench", kind: "observes", provenance: "local-document" },
  { from: "task/GUI-403", to: "fact/GUI-403/F-csp-audit", kind: "observes", provenance: "local-document" },

  // ===== 信号灯样本(DEC-109~112)的 supports 边 =====
  // DEC-109 chosen 引用已失效的 F-perf-baseline(被 F-perf-v2 invalidated)→ evidence 活性灯黄
  { from: "decision/DEC-109/CH1", to: "fact/KER-106/F-perf-baseline", kind: "supports", provenance: "local-document", rationale: "旧性能基线曾支撑深度上限论证,但已被重测推翻" },
  // DEC-110 chosen → 活 fact(覆盖度可达,evidence 活性绿;但 applies_to 漂移黄)
  { from: "decision/DEC-110/CH1", to: "fact/KER-109/F-pty-bench", kind: "supports", provenance: "local-document", rationale: "PTY 基准说明锁竞争在并发下可观测" },
  // DEC-112 chosen → 活 fact(覆盖度可达;但冲突标记红)
  { from: "decision/DEC-112/CH1", to: "fact/KER-109/F-pty-bench", kind: "supports", provenance: "local-document", rationale: "daemon 并发基准证明 service 同面写的吞吐可行" },
  // DEC-111 chosen evidence 为空(无 supports 边)→ 覆盖度不可达灯红,演示空 evidence
];

/* ---------------- 三元语：Decision（why，脊梁）+ Fact（is）---------------- */
