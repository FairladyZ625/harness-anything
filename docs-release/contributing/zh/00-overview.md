# 贡献概览

Harness Anything 的公开贡献经过普通 git review、GitHub required CI 和
maintainer 控制的合入路径。合格贡献需要范围清楚、证据可复现、PR 双语正文完整，且
公开 diff 不包含私有或机器本地上下文。

## 流程权威

请在协助开发的 coding agent 中安装或加载
[`harness-contributing`](../../../skills/harness-contributing/SKILL.md)。这份 skill
是从 issue scope、独立 worktree、测试与 manifest gate、PR body 预检、review
triage 到合入 handoff 的唯一可执行路径。

本目录只解释流程背后的原因和边界，不复制命令，也不维护第二份 checklist。如果本文与
当前机读 surface 不一致，应按 skill 的指引读取实时 PR template、gate manifest 和
package scripts。

## 从哪里开始

- 实现已接受的 issue 或 maintainer 批准的改动：从
  [贡献 skill](../../../skills/harness-contributing/SKILL.md) 开始。
- 报告新的公开 bug 或文档缺口：先看 [提 GitHub issue](06-github-issues.md)。
- 修改 release 或 packaging 说法前：先看
  [Release Posture](../../release-posture.md)。

## 背景页面

- [本地准备](01-local-setup.md)：说明 worktree 和公开边界为何存在。
- [改动流程](02-change-flow.md)：说明 scope 与架构预期。
- [CI 与证据](03-ci-and-evidence.md)：说明 gate 权威模型。
- [PR、审查与合入](04-pr-review-and-merge.md)：说明 reviewer 与 maintainer 责任。
- [Agent 贡献者](05-agent-contributors.md)：说明 agent 的证据和权限边界。

外部贡献者及其 agent 只有 proposal authority：可以准备和更新 branch/PR，最终合入权
属于 maintainer。
