## Harness CLI (software/coding)

- 通过 `ha <command>` 或 `npx harness-anything <command>` 调用。用 `ha task create --title "<title>"` 创建任务包；不要在 tasks 根下手工搭目录。
- 创建任务前先选 preset。创建 milestone root 用 `create-milestone`，普通实现或文档修复用 `standard-task`，里程碑收尾用 `milestone-closeout`，遗留迁移用 `legacy-migration`，模块搭建用 `module`，长跑任务用 `long-running-task`，经验沉淀用 `lesson-sedimentation`，版本升级用 `version-upgrade`，发布相关用 `publish-standard` / `release-closeout`。若运营文档落后于活跃决策或 ADR，用 `doc-canon-sync` 并运行 `ha preset action doc-canon-sync check --task <id> --allow-scripts` 产出 `artifacts/doc-canon-drift.json`。拿不准就 `ha preset list`；不要什么都默认 `standard-task`。
- 组装写入前优先自描述：`ha <command> --help`、preset manifest、capabilities 元数据。命令支持 JSON / `--from-file` 时用结构化输入，别塞 shell 转义的长文本；不支持时用当前 flag。
- 复核与完成：用 `ha task transition <id> in_review` 进入 review，用真实证据替换占位的 review/closeout 内容，运行 `ha task review <id>`，再 `ha task complete <id> --ci passed|failed`。缺事实、占位 review 或占位 closeout 都会 fail closed。
- 走投影查询：`ha decision list --state active --module <key> --compact`、`ha decision show <id|E<n>>`、`ha task list --module <key>`。
- 非 coordinator 写入收尾：手工改文档、标准、模板、artifact 索引或源码后，结束前检查对应仓库 `git status --short`，只提交自己触碰的路径；不要把已有无关脏文件卷进来。若明确不提交，必须记录 owner 和 no-commit 理由。
- 模板资产是操作面的一部分。AGENTS/task/governance 工作流文本变更时，同步更新 seeded 模板，避免新 scaffold 教旧行为。

## Scaffold folders (see each folder README, do not duplicate here)

每个 scaffold 文件夹自己持有其用法的唯一真源。本入口只做路由，绝不复述各文件夹的细则（反漂移，ADR-0021 D3）：

- ADR 纪律 → `harness/adr/README.md`
- 决策纪律 → `harness/decisions/README.md`
- 里程碑纪律 → `harness/milestones/README.md`
- 会话、标准与上下文 → `harness/sessions/README.md`、`harness/standards/README.md`、`harness/context/README.md`

## Governance routing (near-field hard gates)

- PR / 分支 / 合并 / admin bypass → `harness/standards/repo-governance.md` 与 `.github/pull_request_template.md`
- CI / required checks / 发布门禁 → `harness/standards/ci-cd-standard.md`
- 测试 tier / 证据深度 / 新测试文件 → `harness/standards/testing-standard.md`

## CI/Gate authority stop condition

- 如果当前任务不是 CI/gate/governance 任务，却需要修改 CI/gate 权威面才能通过，停止实现，记录 blocker，并请求或创建治理任务。
- 允许的例外只有明确授权的 CI/gate/governance 任务，以及紧急修复 main 的 break-glass。break-glass 必须在 PR body 记录原因、范围和后续治理任务。
