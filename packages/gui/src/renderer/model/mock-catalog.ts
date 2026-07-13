import type { EventEntry } from "./types";

export const MOCK_EVENTS: EventEntry[] = [
  { at: "2026-06-12T10:01:00", projectId: "harness-anything", taskId: "GUI-401", summary: "追加进度：主题色值双模式完成" },
  { at: "2026-06-12T09:58:00", projectId: "harness-anything", taskId: "KER-106", summary: "材料齐备 → closeoutReadiness=ready" },
  { at: "2026-06-12T09:55:00", projectId: "coding-agent-harness", taskId: "DOC-12", summary: "材料齐备 → closeoutReadiness=ready" },
  { at: "2026-06-12T09:30:00", projectId: "harness-anything", taskId: "ADP-501", summary: "快照刷新：raw=open:review" },
  { at: "2026-06-12T08:15:00", projectId: "harness-anything", taskId: "KER-102", summary: "进入 Finalizing（封存前暂存）" },
  { at: "2026-06-12T07:55:00", projectId: "harness-anything", taskId: "FAI-37", summary: "freshness 降级 → stale-but-usable" },
  { at: "2026-06-11T22:40:00", projectId: "harness-anything", taskId: "LIN-88", summary: "出现未映射 raw=triage_hold → unknown" },
  { at: "2026-06-11T16:45:00", projectId: "harness-anything", taskId: "CI-602", summary: "review gate 机判 → failed（e2e 3 条用例超时）" },
  { at: "2026-06-11T15:00:00", projectId: "harness-anything", taskId: "STO-210", summary: "材料齐备 → closeoutReadiness=ready" },
  { at: "2026-06-10T16:03:00", projectId: "harness-anything", taskId: "KER-104", summary: "review gate 机判 → passed，可归档" },
];

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

export const DOC_CONTENT: Record<string, string> = {
  "contract.md": SAMPLE_MARKDOWN,
  "design/visual-map.md": SAMPLE_MERMAID_DOC,
  "review/walkthrough.md": SAMPLE_WALKTHROUGH,
};
