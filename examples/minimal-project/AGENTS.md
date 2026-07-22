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

## Harness CLI (software/coding)

- 通过 `ha <command>` 或 `npx harness-anything <command>` 调用。用 `ha task create --title "<title>"` 创建任务包；不要在 tasks 根下手工搭目录。
- 创建任务前先选 preset。普通实现或文档修复用 `standard-task`，长跑任务用 `long-running-task`，模块搭建用 `module`，拆分父任务用 `subtask-expansion`，GitHub issue intake 用 `github-issue-repair`，遗留迁移用 `legacy-migration`；`create-milestone`、`milestone-closeout`、`milestone-dossier` 与 `decision-conformance` 分别用于对应工作流。拿不准就 `ha preset list`；不要什么都默认 `standard-task`。
- 组装写入前优先自描述：`ha <command> --help`、preset manifest、capabilities 元数据。命令支持 JSON / `--from-file` 时用结构化输入，别塞 shell 转义的长文本；不支持时用当前 flag。
- 提交、复核与完成：用 `ha task transition <id> in_review --completion-claim "..."` 提交 active Execution，并按需重复传入 `--deliverable`、`--output`、`--verification`、`--known-gap` 与 `--residual-risk`；纯文字提交与零条 Evidence 合法。另一位 reviewer 再运行 `ha task review-execution <id> --execution-id <exe-id> --verdict <approved|changes_requested|dismissed> --findings "..." --rationale "..." [--evidence-checked <evidence-id>]...` 复核该轮交付。然后运行 `ha task complete <id>`；只有解析出的 preset/profile 声明 `ci` gate 时才传 `--ci passed`。Fact 保持 `0..N` 的显式晋升；review 或 closeout 占位内容仍会 fail closed（依据 `dec_mrg3z1we/CH1`、`CH4`、ADR-0027 D3、D5-D7）。
- 走投影查询：`ha decision list --state active --module <key> --compact`、`ha decision show <id|E<n>>`、`ha task list --module <key>`。
- 手改已登记的人读 task prose 后：先跑 `ha doc status` 与 `ha doc sync --dry-run`，再用可重复的 `ha doc sync --submit --path <authored-relative-path>` 只提交自己拥有的路径；daemon 校验区域并创建归因 commit，不要补第二次 raw Git commit。
- 顶层 ADR、standard、template 与 repository-agent prose 在 write-road registry 明确登记前仍走既有治理仓库流程；未知 Markdown 会 fail closed。
- authored harness 之外的公开源码与 release docs 仍走正常代码 PR Git 流程：检查 `git status --short`，只 stage 自己触碰的路径，不要卷入已有无关 dirty；明确不提交时记录 owner 与 no-commit 理由。
- 模板资产是操作面的一部分。AGENTS/task/governance 工作流文本变更时，同步更新 seeded 模板，避免新 scaffold 教旧行为。

## Scaffold folders (see each folder README, do not duplicate here)

每个 scaffold 文件夹自己持有其用法的唯一真源。本入口只做路由，绝不复述各文件夹的细则（反漂移，ADR-0021 D3）：

- ADR 纪律 → `harness/adr/README.md`
- 决策纪律 → `harness/decisions/README.md`
- 里程碑纪律 → `harness/milestones/README.md`
- 会话、标准与上下文 → `harness/sessions/README.md`、`harness/standards/README.md`、`harness/context/README.md`

## Architecture-aware code changes

- 每个 coding task 开始时、广泛搜索源码前，先检查 `harness/context/architecture/architecture-manifest.json` 是否存在。存在时先读 `harness/context/architecture/README.md`，再只加载与任务相关的稳定 view/flow，然后选择实现层级；manifest 不存在时继续普通 coding 流程。
- 跨 package、陌生区域、写路径、runtime boundary、依赖方向或 canonical owner 不明确的任务，进入代码前必须先解析 stable node、view/flow 与 source scope，并在 `code-impact-analysis.md` 记录这些稳定引用；不要把模型事实复制进 task。docs-only 或明确局部低风险的修改可以把架构影响记为 N/A，但必须写理由。
- 如果源码搜索出现多个可能的 owner/层级、incomers/outgoers 不确定或文档互相冲突，停止搜索并先回到地图，再按 stable node → view/flow → source scope → code 的顺序继续。
- 对已有 manifest 且适用的 task，在实现前运行 `ha script run vertical:software-coding:architecture-check --task <task-id>`。把 `drifted`、`invalid` 或 `tool-missing` 作为证据呈现；不得隐藏模型与 snapshot 冲突，也不得把 architecture check 变成 completion gate。

## Governance routing (near-field hard gates)

- PR / 分支 / 合并 / admin bypass → `harness/standards/repo-governance.md` 与 `.github/pull_request_template.md`
- CI / required checks / 发布门禁 → `harness/standards/ci-cd-standard.md`
- 测试 tier / 证据深度 / 新测试文件 → `harness/standards/testing-standard.md`
- package 邻接、deep subpath 与 source-path 边 → `tools/package-boundaries.json` + `npm run harness:check-package-boundaries`；写路径全根账本 → `tools/write-road-registry.json` + `npm run harness:check-write-road-registry`

## CI/Gate authority stop condition

- 如果当前任务不是 CI/gate/governance 任务，却需要修改 CI/gate 权威面才能通过，停止实现，记录 blocker，并请求或创建治理任务。
- 允许的例外只有明确授权的 CI/gate/governance 任务，以及紧急修复 main 的 break-glass。break-glass 必须在 PR body 记录原因、范围和后续治理任务。

## Repository Specifics

The init Configure/Verify step fills this section from repository diagnosis (stack, test command, CI required checks, PR template, branch protection, monorepo signals). It stays empty until diagnosis runs and never rewrites the sections above it.
