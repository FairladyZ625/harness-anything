# Harness Agent Entry

在改变任务状态前，先读 `harness/harness.yaml` 与 `harness/standards/repo-governance.md`。

## Kernel Workflow (triadic)

三元语工作流是强制的，任何一条都不能跳过：

- 任务进展是工作状态的时间线：`ha task transition <id> active`，随后 `ha task progress append <id> --text "<记录>" --evidence type:PATH:summary`。进展是时间线，不是事实账本。
- 事实是承重观察，任务本地、只追加：`ha fact record --task <id> --statement "<可复核观察>" --source "<来源>" --confidence high`。任何进入 review/complete 的任务至少要有一条真实事实，否则 fail closed。
- 决策是承重选择、反转与长效边界：`ha decision propose --title ... --question ... --chosen ... --rejected ... --why-not ...`。裁决暴露出战略问题时才算决策。
- 关系连接跨实体依赖：`ha decision relate <id> --anchor <CH1|C1|RJ1> --type supports|supersedes|refines|narrows|relates --target <entity-ref> --rationale "..."`。孤立实体是审计发现。

## WriteCoordinator discipline

- 经 harness CLI 的写入，在 harness 根位于 git 仓库内时会自动提交，提交信息带语义，如 `task(progress-append): <id>` 或 `decision(relate): <id>`。不要为协调器所有的写入再补一次提交。手改的散文仍需正常提交。
- 边界：机读字段与关系必须走 CLI 命令写入。人读散文可以直接编辑，但不替代事实、决策与关系。
- 处置：不要物理删除决策，用 supersede 或 retire；事实只追加，用失效而非改写；删除或归档前先检查关系级联影响。

## Task reading matrix

只加载当前任务需要的内容：本文件、动作路由到的 `harness/standards/` 文件、以及任务包目录。不要预载整个仓库。

`.harness/` 下的生成态仅本地有效，不得提交。
