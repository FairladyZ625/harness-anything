# Collaboration Layout Review Brief

- **Status**: historical-review-input; dispositions recorded in §7
- **Date**: 2026-06-12
- **Purpose**: 给 Claude / 外部架构审查者的上下文包，审查 Harness Anything 的多人协作目录模型、生成物位置、Task ID 策略和 M1 开工前需要修正的计划口径。

## 1. 背景

当前 `harness-anything` 还没有完成新 harness kernel，因此本仓库仍由旧 `legacy harness` 的私有运行仓库协调：

```text
harness-anything/harness/
```

这个路径是 bootstrap 期的私有脚手架，不代表 Harness Anything 产品默认行为。

产品默认场景应是：Harness 的 authored docs/tasks 跟目标代码仓库一起版本化，多人共享、PR review、merge conflict 可处理。不是每个人一份独立 harness repo。

## 2. 新协作模型假设

应区分三类数据：

```text
target-repo/
  harness/                  # shared authored truth, git tracked
    context/
    planning/tasks/
    standards/
    templates/
    decisions/
    governance/             # authored governance rules only

  .harness/                 # local generated/runtime, gitignored
    generated/
    cache/
    write-journal/
    locks/
```

### 2.1 Shared Authored Truth

进 Git，多人共享，需要 review：

- context / architecture / decisions
- standards / templates
- task packages: `INDEX.md`, `task_plan.md`, `findings.md`, `progress.md`, `walkthrough.md`, `review.md`
- packet contracts / dispatch contracts

### 2.2 Generated Rebuildable Views

默认不进 Git；每个 checkout 可从 authored truth 重建：

- task index
- relation graph
- lifecycle status projection
- dashboard bundle
- status matrix
- generated governance tables

这些应位于 `.harness/generated/` 或 `.harness/cache/`，而不是 shared authored tree。

### 2.3 Local Runtime State

绝不进 Git：

- SQLite projection/cache
- write journal
- locks
- external adapter snapshots
- local runtime overrides

## 3. 已发现的计划漂移

本节记录修订前的诊断，保留给外部 reviewer 理解问题来源。2026-06-12 的修订处置见 §7。

### 3.1 `governance/generated/` 位置不对

`harness/contracts/21-repository-context-package-tree.md` 目前把 `governance/generated/` 放在 `harness` authored tree 下：

```text
harness/
  governance/
    generated/
```

这对 bootstrap 私有脚手架可接受，但不应成为产品默认。多人协作时，生成表被 Git 跟踪会制造频繁冲突。

### 3.2 Task identity 仍偏 slug

`10-foundation/02-domain-model.md` 和 M1 breakdown 仍有“Task 身份 = slug / task-id slug 为身份锚点”的表述。

多人协作下，应默认使用随机稳定 ID：

```text
task_01JZ8K9R4W6Y3Q8P7N2K5M1A0B
task_01JZ8K9R4W6Y3Q8P7N2K5M1A0B-local-loop-completion
```

其中随机 ID 是 identity，slug/title 只是展示。

### 3.3 `new-task <id>` 不应是默认主路径

`10-foundation/07-cli-command-surface.md` 当前主命令是：

```text
harness new-task <id> [--title ...]
```

更适合多人协作的默认主路径应是：

```text
harness new-task --title "Local loop completion"
```

CLI 自动生成 random ID。手动 `--id` 可以保留为高级/迁移选项，但不应是默认协作路径。

### 3.4 AGENTS.md / standards 需要冲突控制

`AGENTS.md` 应作为短入口和稳定 shim，尽量少改；具体标准拆到：

```text
harness/standards/*.md
harness/templates/*.md
```

否则多人同时修改一个大 AGENTS.md 会高频冲突。

### 3.5 M2 文档仍把 generated 当 shared target

`harness/milestones/foundation/m2-coding-vertical/02-feature-breakdown-vertical-preset.md` 多处使用 `governance/generated`。需要改为：generated 默认写 `.harness/generated`；shared `governance/` 只放 authored governance rules / standards / decisions。

## 4. M1 开工前建议修正

在第一个 M1 task 中加入 `Collaboration Layout Correction` 子目标，先修设计口径再实现 CLI：

- 更新 `harness/contracts/21-repository-context-package-tree.md`：三层目录模型。
- 更新 `harness/contracts/18-schema-contracts-and-validation.md`：`harness.yaml` 区分 authored root、generated root、runtime root。
- 更新 `10-foundation/02-domain-model.md`：TaskId = random stable id；slug/title 非 identity。
- 更新 `10-foundation/07-cli-command-surface.md`：`new-task` 默认生成 ID，`--id` 仅高级/迁移选项。
- 更新 M1 breakdown/status：移除 “task-id slug 为身份锚点”。
- 更新 M2 vertical preset：`governance/generated` 改为 `.harness/generated`。
- 更新 packet template：worker 不直接编辑 generated/status tables；由 generator 或 coordinator 写入。

## 5. 希望 Claude 审查的问题

请重点回答：

1. 上述三层模型是否足以支撑多人协作的文档驱动 harness？
2. `harness/` 作为 shared authored root、`.harness/` 作为 local generated/runtime root 是否边界清楚？
3. generated views 默认不入 Git 是否会丢失团队需要共享的状态？如果会，哪些 generated artifact 应允许显式 export/snapshot？
4. Task ID 是否应强制 random stable id？目录名是否应允许 `task_<id>-slug`？
5. `harness new-task` 默认自动生成 ID 是否合理？是否需要保留手动 id？
6. AGENTS.md / standards / templates 的拆分是否能降低 merge conflicts？
7. M1 第一个 task 是否应该先做 Collaboration Layout Correction，再实现 init、new-task、archive、status、check、rebuild？
8. 是否有 P0 风险或遗漏，会导致后续实现重工？

## 6. Prompt To Claude

```text
请做一次架构设计审查。背景：我们正在用旧 legacy harness 私有脚手架管理新项目 Harness Anything 的 clean-room rewrite；新 kernel 还没完成，所以当前路径 `harness-anything/harness/` 只是 bootstrap 期私有运行仓库，不代表产品默认行为。

请重点审查 Harness Anything 的多人协作文档模型。产品默认应是：Harness 的 authored docs/tasks 跟目标代码仓库一起版本化，多人共享、PR review、merge conflict 可处理；不是每个人一份独立 harness repo。

我提出的模型是三层：

1. `harness/`：shared authored truth，进 Git。包含 context、planning/tasks、standards、templates、decisions、authored governance rules。
2. `.harness/generated` / `.harness/cache`：generated rebuildable views，默认不进 Git。包含 task index、relation graph、lifecycle projection、dashboard bundle、status matrix。
3. `.harness/write-journal` / `.harness/locks` / adapter snapshots：local runtime state，绝不进 Git。

现有计划里可能需要修：

- `harness/contracts/21-repository-context-package-tree.md` 现在把 `governance/generated/` 放在 authored tree 下，可能会造成多人 PR 高频冲突。
- `10-foundation/02-domain-model.md` 仍有 “Task 身份 = slug” 的口径；多人协作下应改为 random stable id，例如 `task_<ULID>`，slug/title 只是展示。
- `10-foundation/07-cli-command-surface.md` 当前是 `harness new-task <id>`；默认应改为 `harness new-task --title ...` 自动生成 ID，手动 `--id` 仅高级/迁移选项。
- AGENTS.md 应是短入口，具体标准拆到 `harness/standards/*.md` 和 `harness/templates/*.md`，降低 merge conflicts。
- M2 文档多处 `governance/generated` 应改为 `.harness/generated`，shared governance 只放 authored rules/standards/decisions。

请回答：

1. 这个三层模型是否足以支撑多人协作？
2. generated views 默认不入 Git 是否正确？哪些 generated artifact 需要允许显式 export/snapshot？
3. random stable task id 是否应成为强制默认？目录名是否可以是 `task_<id>-slug`？
4. `new-task` 默认自动生成 ID 是否合理？是否应保留手动 `--id`？
5. AGENTS.md / standards / templates 这样拆是否能降低冲突？
6. 第一个 M1 task 是否应该先做 Collaboration Layout Correction，再实现 init、new-task、archive、status、check、rebuild？
7. 还有哪些 P0/P1 风险或计划缺口？

请按 Findings 优先输出，标 P0/P1/P2，给出具体建议和需要修改的文档路径。
```

## 7. Claude 反馈摘要（2026-06-12）

Claude 的结论：上面五个修订点都成立，但还缺两个 P0：

1. **产品默认布局必须显式定义**：authored harness 跟目标代码仓库一起进 Git；`harness`
   只是 private/bootstrap 部署模式，不是产品默认。
2. **merge contract 必须是产品功能**：Git merge 是多人并发控制边界；CLI/CI 要通过 post-merge
   checker 检测重复 TaskId、generated tracked、binding tamper、conflict markers、dangling refs，并输出
   agent 可执行的修复提示。

补充采纳项：

- generated views 默认不进 Git；允许显式 export/snapshot 到 artifacts，但必须带 provenance。
- TaskId 必须随机稳定；slug 可以出现在路径里，但身份只能来自 frontmatter。
- `new-task` 默认自动生成 ID；`--id` 仅 migration/import/admin，必须唯一性校验并输出 JSON。
- AGENTS.md 保持短 shim；具体标准拆到 `harness/standards/*.md`，建议配 CODEOWNERS。
- `.harness/locks` 只管单 clone；跨人冲突靠 Git merge + checker，不靠 lock。

因此第一张 M1 task 应切成“Collaboration Layout + Merge Contract”，先修文档契约，再让后续
WriteCoordinator/ArtifactStore/CLI 按新路径和身份模型实现。
