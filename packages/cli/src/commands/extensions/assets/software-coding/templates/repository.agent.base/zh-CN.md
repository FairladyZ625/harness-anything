# Harness Agent Entry

本入口只放稳定运行规则。当前里程碑、roadmap 状态和任务背景属于当前任务包，不放进 AGENTS.md。

## Context loading

- 读取 `harness/harness.yaml`。
- 如果已有 task，先读该 task 的 `task_plan.md` 以及其中明确列出的文件。
- 从任务路由到最小必要的标准或文件夹 README。不要预载整个 ADR、decision、milestone 或 standards 树。

## Worktree discipline

- 后台/并行 worker，以及任何 public implementation 或 public docs PR，都从最新 `origin/main` 在 `.worktrees/<slug>` 创建 `codex/<slug>` 分支。
- 不要在共享仓库根工作树里改 `packages/**`、`tools/**`、`docs-release/**` 或公开根配置。共享 root 只做 coordinator、私有 harness、local ignored entry 文件和最终同步。
- 已有无关脏文件留在原 checkout。合并后删除远端 PR 分支，清理本地 worktree/branch，并记录无法清理的 residual。

## Kernel Workflow (triadic)

- `task` 是工作单元和状态时间线。
- `fact` 是 task-local、append-only、对承重观察的 `0..N` 显式晋升。交付证据归入 Execution outputs；review 与 completion 不设 Fact 数量门。
- `decision` 是承重 why：选路、推翻、长期边界，以及派生后续工作的判断。
- prose 提及不能替代 fact、decision 或 relation。

## Relation edge rules

- relation 写入使用 canonical id。legacy `E<n>` selector 只是 `ha decision show` 等投影读便利；不要假设写命令接受。
- decision 到 task 的边：decision 直接派生 task 时用 `derives`；task 后来发现有关联时用 `relates`。
- `refines` 是 decision 到 decision 的修订关系，不用于 target `task/...`。

## WriteCoordinator discipline

- 经 harness CLI 的写入在 harness root 位于 Git 仓内时会自动提交。不要为 coordinator-owned 写入补第二个提交。
- 手工编辑 prose、标准、模板、artifact 索引或源码后，执行 agent 必须检查 `git status --short`，只 stage 本任务触碰的路径并提交；无关脏文件保持原状。
- 机读字段和 relation 必须通过 CLI 写入。人读 prose 可以直接编辑，但不会创建 graph state。

`.harness/` 下的生成态仅本地有效，不得提交。
