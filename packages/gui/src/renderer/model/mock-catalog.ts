/* 移植自原型：vertical / template / preset / adapter / event / 文档样例 mock 数据 */
import type {
  PresetEntry,
  VerticalInfo,
  TemplateInfo,
  AdapterInfo,
  EventEntry,
} from "./types";

export const MOCK_VERTICALS: VerticalInfo[] = [
  {
    id: "software/coding",
    name: "software/coding",
    version: "1.2.0",
    description: "软件工程场景：三元语 task/decision/fact + composite milestone + PRD 合同槽位",
    entityKinds: [
      { id: "task", kind: "lifecycle", contractEntity: true },
      { id: "decision", kind: "lifecycle", contractEntity: true },
      { id: "fact", kind: "schema", contractEntity: false },
      { id: "milestone", kind: "composite", contractEntity: true },
      { id: "PRD", kind: "lifecycle", contractEntity: true },
    ],
    slots: [
      { slot: "task.contract", required: true },
      { slot: "task.flow", required: true },
      { slot: "plan.milestones", required: false },
      { slot: "design.decisions", required: false },
      { slot: "closeout.walkthrough", required: true },
      { slot: "closeout.lesson", required: false },
      { slot: "evidence.run-log", required: true },
    ],
  },
  {
    id: "docs",
    name: "docs",
    version: "1.1.0",
    description: "文档写作场景：task/decision/fact + EditorialBrief 合同槽位",
    entityKinds: [
      { id: "task", kind: "lifecycle", contractEntity: true },
      { id: "decision", kind: "lifecycle", contractEntity: true },
      { id: "fact", kind: "schema", contractEntity: false },
      { id: "EditorialBrief", kind: "lifecycle", contractEntity: true },
    ],
    slots: [
      { slot: "doc.outline", required: true },
      { slot: "review.checklist", required: true },
      { slot: "release.check", required: false },
    ],
  },
];

export const MOCK_TEMPLATES: TemplateInfo[] = [
  {
    ref: "template://contract/task-contract@2",
    kind: "contract",
    version: "2",
    locales: ["en-US", "zh-CN"],
    usedBy: ["engineering-default", "research-spike"],
    description: "任务契约：intent / scope / acceptance / stop / links",
  },
  {
    ref: "template://planning/task-flow@1",
    kind: "flow",
    version: "1",
    locales: ["en-US", "zh-CN"],
    usedBy: ["engineering-default"],
    description: "单任务内部阶段流程（不进 Kernel 默认包）",
  },
  {
    ref: "template://planning/milestones@1",
    kind: "planning",
    version: "1",
    locales: ["en-US", "zh-CN"],
    usedBy: ["engineering-default"],
    description: "里程碑计划骨架",
  },
  {
    ref: "template://design/decision-log@1",
    kind: "design",
    version: "1",
    locales: ["en-US"],
    usedBy: ["harness-rewrite"],
    description: "设计决策记录（ADR 风格）",
  },
  {
    ref: "template://closeout/walkthrough@3",
    kind: "closeout",
    version: "3",
    locales: ["en-US", "zh-CN"],
    usedBy: ["engineering-default", "zeyu-dense-review"],
    description: "收口 walkthrough：场景中立，Kernel closeout 基线",
  },
  {
    ref: "template://evidence/run-log@1",
    kind: "evidence",
    version: "1",
    locales: ["en-US", "zh-CN"],
    usedBy: ["engineering-default", "zeyu-dense-review"],
    description: "执行证据日志",
  },
  {
    ref: "template://docs/outline@1",
    kind: "outline",
    version: "1",
    locales: ["en-US", "zh-CN"],
    usedBy: ["docs-default"],
    description: "写作大纲骨架",
  },
  {
    ref: "template://review/editorial-checklist@1",
    kind: "checklist",
    version: "1",
    locales: ["en-US"],
    usedBy: ["docs-default"],
    description: "编辑评审清单",
  },
];

export const MOCK_PRESETS: PresetEntry[] = [
  {
    id: "engineering-default",
    name: "engineering-default",
    source: "builtin",
    version: "1.4.0",
    description: "标准工程任务包：契约 + 流程 + 里程碑 + 收口 + 证据",
    vertical: "software/coding",
    capabilityImports: ["checker:import-boundary"],
    profile: "standard",
    selections: [
      {
        slot: "task.contract",
        templateRef: "template://contract/task-contract@2",
        materializeAs: "contract.md",
        locales: ["en-US", "zh-CN"],
      },
      {
        slot: "task.flow",
        templateRef: "template://planning/task-flow@1",
        materializeAs: "task_flow.md",
        locales: ["en-US", "zh-CN"],
      },
      {
        slot: "plan.milestones",
        templateRef: "template://planning/milestones@1",
        materializeAs: "plan/milestones.md",
        locales: ["en-US", "zh-CN"],
      },
      {
        slot: "closeout.walkthrough",
        templateRef: "template://closeout/walkthrough@3",
        materializeAs: "review/walkthrough.md",
        locales: ["en-US", "zh-CN"],
      },
      {
        slot: "evidence.run-log",
        templateRef: "template://evidence/run-log@1",
        materializeAs: "evidence/run-log.md",
        locales: ["en-US", "zh-CN"],
      },
    ],
    overriddenBy: "zeyu-dense-review",
  },
  {
    id: "research-spike",
    name: "research-spike",
    source: "builtin",
    version: "0.9.2",
    description: "研究型 spike：轻量契约 + 结论备忘，无强制收口",
    vertical: "software/coding",
    capabilityImports: [],
    profile: "simple",
    selections: [
      {
        slot: "task.contract",
        templateRef: "template://contract/task-contract@2",
        materializeAs: "contract.md",
        locales: ["en-US", "zh-CN"],
      },
    ],
  },
  {
    id: "docs-default",
    name: "docs-default",
    source: "builtin",
    version: "1.1.0",
    description: "文档类任务默认包：写作大纲 + 评审清单 + 发布检查",
    vertical: "docs",
    capabilityImports: ["checker:doc-anchors"],
    selections: [
      {
        slot: "doc.outline",
        templateRef: "template://docs/outline@1",
        materializeAs: "outline.md",
        locales: ["en-US", "zh-CN"],
      },
      {
        slot: "review.checklist",
        templateRef: "template://review/editorial-checklist@1",
        materializeAs: "review/checklist.md",
        locales: ["en-US"],
      },
    ],
  },
  {
    id: "zeyu-dense-review",
    name: "zeyu-dense-review",
    source: "user",
    version: "0.3.1",
    description: "覆盖 engineering-default 的收口骨架：双人审阅记录 + 证据强校验",
    vertical: "software/coding",
    extends: "engineering-default",
    capabilityImports: ["checker:evidence-strict"],
    profile: "standard",
    selections: [
      {
        slot: "closeout.walkthrough",
        templateRef: "template://closeout/walkthrough@3",
        materializeAs: "review/walkthrough.md",
        locales: ["en-US", "zh-CN"],
      },
      {
        slot: "evidence.run-log",
        templateRef: "template://evidence/run-log@1",
        materializeAs: "evidence/run-log.md",
        locales: ["en-US", "zh-CN"],
      },
    ],
    overriddenBy: "harness-rewrite",
  },
  {
    id: "harness-rewrite",
    name: "harness-rewrite",
    source: "project",
    version: "2026.06",
    description: "kernel-rewrite 专用：三轴投影验收 + import-boundary 证据 + 安全合同检查",
    vertical: "software/coding",
    extends: "zeyu-dense-review",
    capabilityImports: [
      "checker:security-contract",
      "projection:import-boundary-evidence",
    ],
    profile: "complex",
    selections: [
      {
        slot: "design.decisions",
        templateRef: "template://design/decision-log@1",
        materializeAs: "design/decisions.md",
        locales: ["en-US"],
      },
    ],
  },
];

/* ---------------- Adapter ---------------- */

export const MOCK_ADAPTERS: AdapterInfo[] = [
  {
    engine: "local",
    displayName: "Local Documents",
    connected: true,
    authHint: "无需认证",
    boundCount: 24,
    lastSnapshotAt: null,
    freshness: "fresh",
    mapping: [],
    unmappedRaw: [],
  },
  {
    engine: "multica",
    displayName: "Multica",
    connected: true,
    authHint: "凭证 · keychain",
    boundCount: 3,
    lastSnapshotAt: "2026-06-12T07:55:00",
    freshness: "stale-but-usable",
    mapping: [
      { raw: "queued", canonical: "planned" },
      { raw: "running", canonical: "active" },
      { raw: "waiting_local_directory", canonical: "blocked" },
      { raw: "done", canonical: "done" },
    ],
    unmappedRaw: [],
  },
  {
    engine: "github",
    displayName: "GitHub Issues",
    connected: true,
    authHint: "gh 凭证 · keychain",
    boundCount: 4,
    lastSnapshotAt: "2026-06-12T09:30:00",
    freshness: "fresh",
    mapping: [
      { raw: "open", canonical: "planned" },
      { raw: "open:in-progress", canonical: "active" },
      { raw: "open:review", canonical: "in_review" },
      { raw: "closed", canonical: "done" },
      { raw: "closed:not-planned", canonical: "cancelled" },
    ],
    unmappedRaw: [],
  },
  {
    engine: "linear",
    displayName: "Linear",
    connected: true,
    authHint: "api key · keychain",
    boundCount: 5,
    lastSnapshotAt: "2026-06-11T22:40:00",
    freshness: "stale-but-usable",
    mapping: [
      { raw: "Todo", canonical: "planned" },
      { raw: "In Progress", canonical: "active" },
      { raw: "In Review", canonical: "in_review" },
      { raw: "Done", canonical: "done" },
      { raw: "Canceled", canonical: "cancelled" },
    ],
    unmappedRaw: ["triage_hold", "backlog_grooming"],
  },
];

/* ---------------- 近期事件流 ---------------- */

export const MOCK_EVENTS: EventEntry[] = [
  { at: "2026-06-12T10:01:00", projectId: "harness-anything", taskId: "GUI-401", summary: "追加进度：主题色值双模式完成" },
  { at: "2026-06-12T09:58:00", projectId: "harness-anything", taskId: "KER-106", summary: "材料齐备 → closeoutReadiness=ready" },
  { at: "2026-06-12T09:55:00", projectId: "coding-agent-harness", taskId: "DOC-12", summary: "材料齐备 → closeoutReadiness=ready" },
  { at: "2026-06-12T09:30:00", projectId: "harness-anything", taskId: "ADP-501", summary: "快照刷新：raw=open:review" },
  { at: "2026-06-12T08:15:00", projectId: "harness-anything", taskId: "KER-102", summary: "进入 in_review，等待 human review" },
  { at: "2026-06-12T07:55:00", projectId: "harness-anything", taskId: "FAI-37", summary: "freshness 降级 → stale-but-usable" },
  { at: "2026-06-11T22:40:00", projectId: "harness-anything", taskId: "LIN-88", summary: "出现未映射 raw=triage_hold → unknown" },
  { at: "2026-06-11T16:45:00", projectId: "harness-anything", taskId: "CI-602", summary: "human review → failed（e2e 3 条用例超时）" },
  { at: "2026-06-11T15:00:00", projectId: "harness-anything", taskId: "STO-210", summary: "材料齐备 → closeoutReadiness=ready" },
  { at: "2026-06-10T16:03:00", projectId: "harness-anything", taskId: "KER-104", summary: "human review → passed，可归档" },
];

/* ---------------- 文档内容样例 ---------------- */

export const SAMPLE_MARKDOWN = `# 任务契约：三端口 Schema 契约与校验管线

## 目标

为 \`kernel/ports\` 的三个端口（ArtifactStore、ProjectionStore、EngineGateway）建立
Schema 契约：所有跨端口数据必须经过 schema 校验，未映射字段进入 WARNING 通道。

## 验收标准

- [x] 三端口接口的 Effect Schema 定义完成
- [x] \`status_unmapped\` WARNING 在快照层产生
- [ ] 校验失败的错误信息含字段路径
- [ ] CI 中 schema 契约检查通过

## 状态映射示例

| 外部 raw | canonical | 备注 |
| --- | --- | --- |
| \`waiting_local_directory\` | \`blocked\` | Multica 等待目录绑定 |
| \`open:in-progress\` | \`active\` | GitHub label 组合 |
| \`triage_hold\` | \`unknown\` | 未映射，产生 WARNING |

## 关键约束

> \`unknown\` 不是第 7 态：它是 snapshot 层的展示值，不能作为状态转换目标，
> 不能写回 domain，不能被 adapter 当默认值。

\`\`\`ts
type SnapshotStatus = DomainStatus | "unknown";
\`\`\`
`;

export const SAMPLE_MERMAID_DOC = `# 可视化地图

## 写入路径

\`\`\`mermaid
flowchart LR
  GUI[GUI / CLI] --> SVC[kernel/application]
  SVC --> WC[WriteCoordinator]
  WC --> GIT[(Git SoT)]
  GIT --> PROJ[SQLite 投影]
  PROJ --> GUI
\`\`\`

## 三轴状态机（coordinationStatus）

\`\`\`mermaid
stateDiagram-v2
  [*] --> planned
  planned --> active
  active --> blocked
  blocked --> active
  active --> in_review
  in_review --> done
  in_review --> active : review failed + 显式打回
  planned --> cancelled
\`\`\`
`;

export const SAMPLE_WALKTHROUGH = `# Walkthrough

## 改动概览

1. \`ports/schema.ts\` 新增三端口 Effect Schema 定义。
2. 快照层接入 \`status_unmapped\` WARNING 通道。
3. 校验失败错误信息带字段路径（\`ParseError.path\`）。

## 验证方式

\`\`\`bash
pnpm test --filter kernel-ports
pnpm check:import-boundary
\`\`\`

## 风险与回滚

- Schema 收紧可能拒绝旧缓存：已提供 \`governance rebuild\` 兜底。
- 回滚 = revert 单一提交，无数据迁移。
`;

/** 按文档路径取内容样例；未命中时回退到 SAMPLE_MARKDOWN */
export const DOC_CONTENT: Record<string, string> = {
  "contract.md": SAMPLE_MARKDOWN,
  "design/visual-map.md": SAMPLE_MERMAID_DOC,
  "review/walkthrough.md": SAMPLE_WALKTHROUGH,
};
