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

- 若存在 `harness/context/architecture/architecture-manifest.json`，选择实现层级前先读 `harness/context/architecture/README.md`，按其中的查询路由定位，并在 `code-impact-analysis.md` 记录稳定架构引用；不要把模型内容复制进 task。
- manifest 不存在时继续普通 coding 流程。docs-only 或明确局部低风险的修改可以把架构影响记为 N/A，但必须写理由。
- 对已有 manifest 且适用的 task，在实现前运行 `ha script run vertical:software-coding:architecture-check --task <task-id>`。把 `drifted`、`invalid` 或 `tool-missing` 作为证据呈现；不得隐藏模型与 snapshot 冲突，也不得把 architecture check 变成 completion gate。

## Governance routing (near-field hard gates)

- PR / 分支 / 合并 / admin bypass → `harness/standards/repo-governance.md` 与 `.github/pull_request_template.md`
- CI / required checks / 发布门禁 → `harness/standards/ci-cd-standard.md`
- 测试 tier / 证据深度 / 新测试文件 → `harness/standards/testing-standard.md`

## CI/Gate authority stop condition

- 如果当前任务不是 CI/gate/governance 任务，却需要修改 CI/gate 权威面才能通过，停止实现，记录 blocker，并请求或创建治理任务。
- 允许的例外只有明确授权的 CI/gate/governance 任务，以及紧急修复 main 的 break-glass。break-glass 必须在 PR body 记录原因、范围和后续治理任务。
