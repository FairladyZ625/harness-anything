/* 移植自原型：decision / fact 三元语 mock 数据 */
import type {
  DecisionRow,
  FactRef,
} from "./types";

export const MOCK_DECISIONS: DecisionRow[] = [
  {
    decisionId: "DEC-101",
    title: "内核改为三元语 decision/task/fact",
    state: "active",
    riskTier: "high",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    proposedBy: { kind: "agent", id: "claude" },
    arbiter: { kind: "human", id: "ZeyuLi" },
    proposedAt: "2026-06-16T03:11:00Z",
    decidedAt: "2026-06-16T04:02:00Z",
    question: "内核是否应以 task 为唯一元语?",
    chosen: [
      { id: "CH1", text: "内核 = decision/task/fact 三元语,decision 为脊梁", evidence: ["fact/KER-101/F-lesson-drift", "fact/KER-106/F-perf-baseline"] },
    ],
    rejected: [
      { id: "RJ1", text: "继续以 task 为唯一元语,lesson 留作 task 子文档", evidence: ["fact/KER-101/F-lesson-drift"], whyNot: "lesson 无消费者,只产不消,记得越多毒越深" },
      { id: "RJ2", text: "新增 facts/ 顶层文件夹,fact 脱离 task 独立存储", evidence: ["fact/KER-106/F-perf-baseline"], whyNot: "fact 失去 provenance 即不可信" },
    ],
    claims: [
      { id: "C1", text: "lesson 缺消费者是 loop 闭不上的根因" },
      { id: "C2", text: "fact 内嵌 task 不搬家,跨任务只靠引用" },
    ],
    provenance: [{ runtime: "claude-code", sessionId: "88833871-9d1c-4aaa-bbbb-cccccccccc01", boundAt: "2026-06-16T03:10:00Z" }],
    lastChangedAt: "2026-06-16T04:02:00Z",
  },
  {
    decisionId: "DEC-102",
    title: "用 SQLite projection 承载代谢图查询",
    state: "proposed",
    riskTier: "medium",
    urgency: "low",
    vertical: "software/coding",
    preset: "architecture-decision",
    proposedBy: { kind: "agent", id: "claude" },
    proposedAt: "2026-06-20T08:00:00Z",
    question: "relation 图遍历用什么承载?",
    chosen: [
      { id: "CH1", text: "SQLite RelationGraphProjection + 递归 CTE", evidence: ["fact/KER-106/F-perf-baseline"] },
    ],
    rejected: [
      { id: "RJ1", text: "引入图数据库", evidence: [], whyNot: "过度工程,SQLite 可重建足够" },
    ],
    claims: [{ id: "C1", text: "覆盖度 = 图可达,非统计" }],
    provenance: [{ runtime: "claude-code", sessionId: "88833871-9d1c-4aaa-bbbb-cccccccccc02", boundAt: "2026-06-20T08:00:00Z" }],
    lastChangedAt: "2026-06-20T08:00:00Z",
  },
  {
    decisionId: "DEC-103",
    title: "decision 写走 PreToolUse 硬 hook",
    state: "retired",
    riskTier: "high",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    proposedBy: { kind: "agent", id: "claude" },
    arbiter: { kind: "human", id: "ZeyuLi" },
    proposedAt: "2026-06-18T10:00:00Z",
    decidedAt: "2026-06-18T11:00:00Z",
    question: "decision 写如何强制走 coordinator?",
    chosen: [{ id: "CH1", text: "PreToolUse 硬拦截", evidence: [] }],
    rejected: [],
    claims: [{ id: "C1", text: "PreToolUse 能拦住 decision 写" }],
    provenance: [{ runtime: "claude-code", sessionId: "88833871-9d1c-4aaa-bbbb-cccccccccc03", boundAt: "2026-06-18T10:00:00Z" }],
    lastChangedAt: "2026-06-25T09:00:00Z",
  },
  {
    decisionId: "DEC-104",
    title: "decision 写走三层软防御(推翻 DEC-103)",
    state: "active",
    riskTier: "high",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    proposedBy: { kind: "agent", id: "claude" },
    arbiter: { kind: "human", id: "ZeyuLi" },
    proposedAt: "2026-06-25T09:00:00Z",
    decidedAt: "2026-06-25T09:30:00Z",
    question: "PreToolUse 拿不到语义,decision 写怎么防?",
    chosen: [{ id: "CH1", text: "路径正则 + 事后 frontmatter check + git precommit", evidence: ["fact/KER-106/F-perf-baseline"] }],
    rejected: [
      { id: "RJ1", text: "继续追求 PreToolUse 真强拦", evidence: [], whyNot: "拿不到语义,猫鼠游戏,交付假象" },
    ],
    claims: [{ id: "C1", text: "承认非真强拦,真 hook defer V2" }],
    provenance: [{ runtime: "claude-code", sessionId: "88833871-9d1c-4aaa-bbbb-cccccccccc04", boundAt: "2026-06-25T09:00:00Z" }],
    lastChangedAt: "2026-06-25T09:30:00Z",
  },
  // ===== 以下为收件箱形态验证新增的 proposed decisions(覆盖 riskTier×urgency 矩阵)=====
  {
    // riskTier=high / urgency=high —— 队首:承重 + 紧急
    decisionId: "DEC-105",
    title: "daemon 并发模型:Actor 池 vs 单线程事件循环",
    state: "proposed",
    riskTier: "high",
    urgency: "high",
    vertical: "software/coding",
    preset: "architecture-decision",
    proposedBy: { kind: "agent", id: "codex" },
    proposedAt: "2026-07-01T14:00:00Z",
    question: "GUI-V1 daemon 同时承载 PTY 会话与 JSON-RPC 写请求,并发模型怎么选?",
    chosen: [
      { id: "CH1", text: "Effect 单线程事件循环 + fiber 调度,PTY 与写请求共享同一 runtime", evidence: ["fact/KER-109/F-pty-bench", "fact/KER-101/F-lesson-drift"] },
    ],
    rejected: [
      { id: "RJ1", text: "引入 tokio 风格 Actor 池,每写请求 spawn 独立 worker", evidence: ["fact/KER-109/F-pty-bench"], whyNot: "WriteCoordinator 已强制串行化,再加 worker 池等于双重锁,并发收益为零却引入竞态面" },
      { id: "RJ2", text: "Node cluster 多进程,每进程一个 daemon", evidence: [], whyNot: "Electron 单进程约束 + 跨进程共享 Git SoT 反而要 IPC 同步,复杂度爆炸" },
    ],
    claims: [
      { id: "C1", text: "写路径已串行,并发只在读侧,事件循环足够" },
      { id: "C2", text: "PTY 流式输出与 JSON-RPC 可在同一 Effect fiber 里交替" },
    ],
    provenance: [
      { runtime: "codex", sessionId: "9a1b2c3d-1111-2222-3333-444444444405", boundAt: "2026-07-01T14:00:00Z" },
    ],
    lastChangedAt: "2026-07-01T14:00:00Z",
  },
  {
    // riskTier=high / urgency=medium —— 承重但不紧急
    decisionId: "DEC-106",
    title: "Electron 渲染进程 CSP:禁用 eval 是否牺牲 hot-reload",
    state: "proposed",
    riskTier: "high",
    urgency: "medium",
    vertical: "software/coding",
    preset: "security-decision",
    proposedBy: { kind: "agent", id: "claude" },
    proposedAt: "2026-06-29T09:00:00Z",
    question: "31A 安全合同要求 CSP 禁 eval,但 Vite dev server 依赖 eval 做 HMR,如何取舍?",
    chosen: [
      { id: "CH1", text: "生产构建硬禁 eval,dev 保留但 contextIsolation + nodeIntegration=false 双保险", evidence: ["fact/GUI-403/F-csp-audit"] },
    ],
    rejected: [
      { id: "RJ1", text: "生产也保留 eval 以统一 dev/prod 构建管线", evidence: ["fact/GUI-403/F-csp-audit"], whyNot: "renderer 进程若被 XSS,eval 是 RCE 直通车道,31A 安全合同的红线不能为工程便利让步" },
      { id: "RJ2", text: "dev 也禁 eval,放弃 HMR 改手动刷新", evidence: [], whyNot: "开发体验劣化导致迭代变慢,而 dev 期威胁模型本就不同(本地、可信源)" },
    ],
    claims: [{ id: "C1", text: "CSP 红线只对 production 恒定,dev 在隔离上下文内可接受" }],
    provenance: [
      { runtime: "claude-code", sessionId: "88833871-9d1c-4aaa-bbbb-cccccccccc06", boundAt: "2026-06-29T09:00:00Z" },
    ],
    lastChangedAt: "2026-06-30T16:00:00Z",
  },
  {
    // riskTier=medium / urgency=high —— 紧急但非承重:验证两轴正交排序(不应被 high risk 抢到队首)
    decisionId: "DEC-107",
    title: "看板拖拽改用 dnd-kit 替换原生 HTML5 DnD",
    state: "proposed",
    riskTier: "medium",
    urgency: "high",
    vertical: "software/coding",
    preset: "implementation-decision",
    proposedBy: { kind: "agent", id: "codex" },
    proposedAt: "2026-07-01T08:00:00Z",
    question: "看板跨列拖拽在触控板与 Firefox 上抖动严重,要不要换底层?",
    chosen: [
      { id: "CH1", text: "迁移到 @dnd-kit/core,保留现有列模型", evidence: ["fact/GUI-401/F-dnd-jank"] },
    ],
    rejected: [
      { id: "RJ1", text: "自己 patch HTML5 DnD 的 dragImage 抖动", evidence: [], whyNot: "浏览器差异是无底洞,dnd-kit 已沉淀跨浏览器/触屏/无障碍方案,自维护成本高于迁移成本" },
      { id: "RJ2", text: "拖拽改点击-选择-移动两步操作,彻底绕开 DnD", evidence: ["fact/GUI-401/F-dnd-jank"], whyNot: "看板是日常操作面,两步操作破坏肌肉记忆,拖拽是该视图的核心交互不该被砍" },
    ],
    claims: [{ id: "C1", text: "dnd-kit 的无障碍 + sensor 抽象覆盖现有全部痛点" }],
    provenance: [
      { runtime: "codex", sessionId: "9a1b2c3d-2222-3333-4444-555555555507", boundAt: "2026-07-01T08:00:00Z" },
    ],
    lastChangedAt: "2026-07-01T08:00:00Z",
  },
  {
    // riskTier=low / urgency=medium —— 低风险因故进人队列(非典型,验证"可快速通过"提示)
    decisionId: "DEC-108",
    title: "TaskPreviewDrawer 默认宽度 380px → 420px",
    state: "proposed",
    riskTier: "low",
    urgency: "medium",
    vertical: "software/coding",
    preset: "ui-polish",
    proposedBy: { kind: "agent", id: "claude" },
    proposedAt: "2026-07-01T11:00:00Z",
    question: "Drawer 在 13 寸屏下切掉 task title 末尾,加宽多少?",
    chosen: [
      { id: "CH1", text: "宽度 380 → 420px,触发断点不变", evidence: ["fact/GUI-401/F-dnd-jank"] },
    ],
    rejected: [
      { id: "RJ1", text: "改响应式 clamp(360px, 30vw, 480px)", evidence: [], whyNot: "原型阶段过度工程,等真实多分辨率使用数据再上响应式" },
    ],
    claims: [{ id: "C1", text: "固定 +40px 覆盖 13/14/15 寸主流屏" }],
    provenance: [
      { runtime: "claude-code", sessionId: "88833871-9d1c-4aaa-bbbb-cccccccccc08", boundAt: "2026-07-01T11:00:00Z" },
    ],
    lastChangedAt: "2026-07-01T11:00:00Z",
  },
  // ===== 信号灯样本(41 §3.1a):全绿 = DEC-105(无字段);以下覆盖黄/红 =====
  {
    // 黄灯①:evidence 活性 —— 引用了被 invalidated_by 标记失效的 fact(F-perf-baseline)
    decisionId: "DEC-109",
    title: "递归 CTE 深度上限设为 32 层",
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "implementation-decision",
    proposedBy: { kind: "agent", id: "codex" },
    proposedAt: "2026-06-24T16:00:00Z",
    question: "RelationGraphProjection 递归遍历的深度上限设多少防 OOM?",
    chosen: [
      // ⚠ 这条 evidence 引用了已失效的 F-perf-baseline(被 F-perf-v2 推翻)→ evidence 活性灯黄
      { id: "CH1", text: "深度上限 32 层,超过截断 + Warning(不挂起)", evidence: ["fact/KER-106/F-perf-baseline"] },
    ],
    rejected: [
      { id: "RJ1", text: "不设上限,依赖内核环检测兜底", evidence: [], whyNot: "环检测是正确性兜底不是性能兜底,深链路 OOM 风险独立存在" },
    ],
    claims: [{ id: "C1", text: "32 层覆盖已知最深的 task 派生链" }],
    provenance: [
      { runtime: "codex", sessionId: "9a1b2c3d-3333-4444-5555-666666666609", boundAt: "2026-06-24T16:00:00Z" },
    ],
    lastChangedAt: "2026-06-24T16:00:00Z",
  },
  {
    // 黄灯②:applies_to 漂移 —— propose 后 applies_to 文档被改(显式 mock 字段)
    decisionId: "DEC-110",
    title: "WriteCoordinator 超时从 5s 收紧到 2s",
    state: "proposed",
    riskTier: "medium",
    urgency: "high",
    vertical: "software/coding",
    preset: "implementation-decision",
    proposedBy: { kind: "agent", id: "claude" },
    proposedAt: "2026-06-28T09:00:00Z",
    question: "daemon 并发后,WriteCoordinator 拿锁超时设多少?",
    chosen: [
      { id: "CH1", text: "超时 5s → 2s,超时即报冲突重试", evidence: ["fact/KER-109/F-pty-bench"] },
    ],
    rejected: [
      { id: "RJ1", text: "保持 5s,容忍长写", evidence: [], whyNot: "daemon 并发后锁竞争加剧,5s 等待让队列堆积,2s + 重试更早暴露冲突" },
    ],
    claims: [{ id: "C1", text: "2s 覆盖 99% 正常写,异常写该报冲突不该闷等" }],
    provenance: [
      { runtime: "claude-code", sessionId: "88833871-9d1c-4aaa-bbbb-cccccccccc10", boundAt: "2026-06-28T09:00:00Z" },
    ],
    lastChangedAt: "2026-06-28T09:00:00Z",
    readinessSignals: {
      // 黄:propose(boundAt 06-28)后,applies_to 文档(kernel/ports/write-coordinator.md)在 06-30 被 KER-109 触碰
      appliesToDrift: {
        docs: ["kernel/ports/write-coordinator.md"],
        lastCommitAt: "2026-06-30T14:20:00Z",
      },
      // accept 成功后需 amend 回写 write-coordinator 文档(演示 42 §4 派生回写提示,此条无冲突故 accept 可达)
      needsWriteback: {
        target: "kernel/ports/write-coordinator.md",
        kind: "amend",
      },
    },
  },
  {
    // 红灯①:覆盖度不可达 —— 承重论点的 evidence 为空 → 活 fact 不可达
    decisionId: "DEC-111",
    title: "投影重建触发条件改为 watermark 落后即触发",
    state: "proposed",
    riskTier: "high",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    proposedBy: { kind: "agent", id: "codex" },
    proposedAt: "2026-07-01T18:00:00Z",
    question: "投影重建是定时触发还是 watermark 落后即触发?",
    chosen: [
      // ⚠ C1 的 chosen evidence 为空 → 覆盖度不可达灯红(承重论点无活 fact 支撑)
      { id: "CH1", text: "watermark 落后 SoT 超 5min 即触发重建", evidence: [] },
    ],
    rejected: [
      { id: "RJ1", text: "定时重建(每 10min)", evidence: [], whyNot: "定时重建在无变更时浪费 IO,落后触发更贴合实际负载" },
    ],
    claims: [{ id: "C1", text: "watermark 落后是重建的充分信号" }],
    provenance: [
      { runtime: "codex", sessionId: "9a1b2c3d-4444-5555-6666-777777777711", boundAt: "2026-07-01T18:00:00Z" },
    ],
    lastChangedAt: "2026-07-01T18:00:00Z",
  },
  {
    // 红灯②:冲突标记 —— findConflictMarkers 命中 + accept 会被 coordinator 拒(演示拒因渲染)
    // 同时标记 needsWriteback:accept 成功(需先解冲突)后会派生 supersede 回写 task
    decisionId: "DEC-112",
    title: "supersede DEC-104:decision 写改走 daemon service",
    state: "proposed",
    riskTier: "high",
    urgency: "high",
    vertical: "software/coding",
    preset: "architecture-decision",
    proposedBy: { kind: "agent", id: "codex" },
    proposedAt: "2026-07-01T20:00:00Z",
    question: "DEC-104 的三层软防御是否应演进为 daemon service 同面写?",
    chosen: [
      { id: "CH1", text: "daemon service 统一写入口,三层软防御收敛为 service 内校验", evidence: ["fact/KER-109/F-pty-bench"] },
    ],
    rejected: [
      { id: "RJ1", text: "保持三层软防御不动", evidence: [], whyNot: "daemon 落地后写路径收敛到 service 是 ADR-0013 D4 的必然,三层软防御是 daemon 前的过渡" },
    ],
    claims: [{ id: "C1", text: "service 同面写满足 P5,软防御内化为 service 校验" }],
    provenance: [
      { runtime: "codex", sessionId: "9a1b2c3d-5555-6666-7777-888888888812", boundAt: "2026-07-01T20:00:00Z" },
    ],
    lastChangedAt: "2026-07-01T20:00:00Z",
    readinessSignals: {
      // 红:findConflictMarkers 命中 —— DEC-104 包有未合并的 amend 与本 supersede 冲突
      conflictMarker: {
        summary: "DEC-104 同时被 DEC-112(supersede)与另一条 amend 修改,findConflictMarkers 检出双重修改冲突",
        conflictingEntity: "DEC-104",
      },
      // accept 成功(需先解冲突)后:声明需 supersede 回写 DEC-104 正文
      needsWriteback: {
        target: "decision/DEC-104",
        kind: "supersede",
      },
    },
  },
];

export const MOCK_FACTS: FactRef[] = [
  { anchor: "KER-101/F-lesson-drift", taskId: "KER-101", category: "lesson", text: "lesson 堆积无消费者 → 认知投降 → 批量确认绕过", at: "2026-06-15T22:00:00Z" },
  { anchor: "KER-106/F-perf-baseline", taskId: "KER-106", category: "finding", text: "SQLite 重建投影在 1k task 规模下 <200ms", at: "2026-06-12T15:00:00Z" },
  { anchor: "KER-106/F-perf-v2", taskId: "KER-106", category: "finding", text: "重测:1k task 递归 CTE 闭包查询 ~450ms(推翻旧基线)", at: "2026-06-24T15:00:00Z", invalidated: true },
  { anchor: "STO-210/F-journal-idem", taskId: "STO-210", category: "progress", text: "journal opId 幂等测试全绿", at: "2026-06-11T09:00:00Z" },
  // 收件箱验证用新增 fact 锚
  { anchor: "KER-109/F-pty-bench", taskId: "KER-109", category: "finding", text: "PTY 1k 行/s 流式输出下,Effect fiber 调度延迟 p99=4ms,无丢帧", at: "2026-06-30T10:00:00Z" },
  { anchor: "GUI-403/F-csp-audit", taskId: "GUI-403", category: "finding", text: "31A 安全审计:eval 在 renderer 是 RCE 放大器,production 必须禁用", at: "2026-06-28T14:00:00Z" },
  { anchor: "GUI-401/F-dnd-jank", taskId: "GUI-401", category: "finding", text: "Firefox + 触控板下 HTML5 DnD dragImage 偏移 ±18px,dnd-kit sensor 抽象消除该抖动", at: "2026-06-29T16:00:00Z" },
];

/* ---------------- Vertical / Template Library / Preset ---------------- */
