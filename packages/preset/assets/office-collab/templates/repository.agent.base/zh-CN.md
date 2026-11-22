# Harness 协同代理入口

本文档定义通过 Harness 治理的通用办公协同工作区运行规则。

## Context Loading

- 按需加载上下文，优先阅读当前 `task_plan.md` 及其显式关联的上游简报、Decision 与 Fact。
- 需要核对工作区治理默认值时运行 `ha settings read`。

## Ownership Discipline

- 修改交付物前先获取任务执行租约。
- 保留无关任务包改动，并如实报告未验证的假设。

## Ledger Workflow

- **Fact**：带明确来源的可复核观察与基线度量。
- **Decision**：有约束力的选择、权衡过程与被拒方案。
- **Task**：由决策或项目目标派生的有界、可验证交付或交接切片。

## Relation Rules

- 使用规范实体 ID 建立因果关系边（`derives`、`evidenced-by`、`depends-on`、`relates`）。

## Write Coordination

- 状态流转、租约获取与关系维护一律经由 `ha` 命令完成。
- 任务文档与结构化产物在 `task submit` 前通过 doc-sync 同步入账。
