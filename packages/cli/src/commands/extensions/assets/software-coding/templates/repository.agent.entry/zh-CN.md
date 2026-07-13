# Harness Agent Entry

这个 standalone 入口只为兼容保留。当前里程碑属于当前任务包，不放进 AGENTS.md。

## Context loading

- 读取 `harness/harness.yaml`。
- 如果已有 task，读取 `task_plan.md` 以及其中明确列出的文件。
- 只加载当前任务相关的标准或文件夹 README。

## Worktree discipline

- public implementation、public docs PR 和后台/并行 worker 都从最新 `origin/main` 在 `.worktrees/<slug>` 使用 `codex/<slug>`。
- 不要在共享仓库根工作树里改公开源码、公开文档或公开根配置。

## Harness CLI

- 通过 `ha <command>` 或 `npx harness-anything <command>` 调用。
- 用 `ha task create --title "<title>" --vertical software/coding --preset <id>` 创建任务包；不要手写 tasks 目录。
- 创建任务前先选 preset。创建 milestone root 用 `create-milestone`；拿不准就运行 `ha preset list`。
- 组装写入前先看 `ha <command> --help`、preset manifest 和 capabilities。
- 用 `ha fact record --task <id> --statement "<可复核观察>" --source "<来源>" --confidence high` 记录承重观察。
- 通过投影查询：`ha decision list --state active --module <key> --compact`、`ha decision show <id|E<n>>`、`ha task list --module <key>`。

## Relation edge rules

- relation 写入使用 canonical decision id。legacy `E<n>` selector 是投影读便利；不要假设写命令接受。
- decision 到 task 的边：decision 直接派生 task 时用 `derives`；task 后来发现有关联时用 `relates`。
- `refines` 是 decision 到 decision 的修订关系，不用于 target `task/...`。

## Write discipline

- harness CLI 写入在 harness root 位于 Git 仓内时会自动提交。不要为 coordinator-owned 写入补第二个提交。
- 手工编辑 prose、标准、模板、artifact 索引或源码后，执行 agent 必须提交自己触碰的路径，不纳入无关脏文件。
- 模板资产是操作面。AGENTS/task/governance 工作流文本变化时，同步更新 seeded templates。

`.harness/` 下的生成态仅本地有效，不得提交。
