# Harness Agent Entry

本文件只保存稳定的仓库运行规则。当前 milestone 状态与任务专属上下文应放在 active task package 中。

## Context Loading

- 读取 `harness/harness.yaml`。
- 已分配 task 时，先读其 `task_plan.md`，再读其中明确列出的文件。
- 从 task 路由到最小必要的 context 或 standard 文档，不要预载整个 authored tree。

## Worktree Discipline

- 实现工作使用隔离 worktree 与任务分支。
- 保留每个 checkout 中的无关改动，只 stage 本任务拥有的路径。
- 遵守任务声明的 base、merge、cleanup 与 publication 指令。

## Kernel Workflow

- task 是工作单元与状态时间线。
- fact 是对承重观察的显式、append-only 晋升；事实数量为可选 `0..N`，不是完成门槛。
- decision 保存承重 why：选择、推翻、长期边界与派生后续工作的判断。
- prose 提及不能替代 canonical fact、decision 或 relation。

## Relation Rules

- relation 写入使用 canonical ID。
- decision 直接派生 task 时用 `derives`，后来发现关联时用 `relates`。
- `refines` 只用于 decision 到 decision 的修订。

## Write Coordination

- 机读字段、生命周期变化与 relation 使用 Harness 命令写入。
- 已登记的 authored prose 按仓库 doc-sync policy 处理。
- `.harness/` 下的 generated state 仅本地有效，不得提交。
