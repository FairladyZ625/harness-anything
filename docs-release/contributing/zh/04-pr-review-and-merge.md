# PR、审查与合入

## PR body 格式

每个公开 PR 都使用 `.github/pull_request_template.md`。正文必须包含两个完整语言块：

1. `# English`
2. `# 中文`

不要逐段交错翻译。英文块本身完整；中文块本身完整。gate 也会检查 PR gate checklist。

## PR 必填内容

填写：

- Summary。
- What Changed。
- Task And Scope。
- Version Impact。
- Verification。
- Review Evidence。
- Residual Risk。
- References。
- PR Gate Checklist。

如果某段不适用，说明原因。不要为了让 PR 看起来更短而删除模板 section。

## Review evidence

Review evidence 包括自查、maintainer review、human review、reviewer subagent 输出，以及 PR 上具体的
bot comments。把 review comments 当成必须 triage 的输入；它们既不是自动真理，也不是噪音。

任何 open P0/P1/P2 finding 在合入前必须处于以下状态之一：

- 已修复；
- 明确是 false-positive，并说明理由；
- 带 owner 和理由延后；
- 阻塞。

不要在未 triage release-blocking finding 的情况下合入。

## Bot comments

如果 Codex Connect Bot、ChatGPT Codex Connector 或其他 review bot 留下具体 comment，要纳入 review
triage。bot 不是合入权威，也不能替代 CI。它是需要评估的证据。

## 合入权限

外部贡献者和他们的 agent 不得把 PR 合入 `main`。

只有 maintainer、仓库 owner 或 maintainer 授权的 admin agent 可以合入，并且必须满足：

- 分支基于当前 `origin/main`，或已经同步；
- required `rewrite-ci` PR lanes 全绿；
- PR 没有 merge conflict；
- PR body 和 checklist 完整；
- review evidence 已 triage；
- 没有 open release-blocking P0/P1/P2 finding。

maintainer 授权的 admin merge 不是跳过 CI 或 review triage 的方式。它是在 gates 满足后的受控合入路径。

## 冲突处理

如果 PR 有 merge conflict，在 PR branch 上 merge 或 rebase `origin/main`，解决冲突，重新运行相关检查，
再等 CI 重跑。

不要通过 force-push 覆盖 `main`、direct-push 到 `main`，或要求 agent 绕过 branch protection 来解决冲突。

## 合入之后

branch cleanup 归 maintainer 负责，除非 maintainer 明确要求贡献者协助。公开贡献在 PR 被合入或被清楚说明原因关闭时完成，
不是在本地代码能跑时完成。
