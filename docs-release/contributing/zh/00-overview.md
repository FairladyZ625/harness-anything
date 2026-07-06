# 贡献概览

Harness Anything 是为 agent 形态的工作流设计的，但贡献仍然必须经过普通的 git
review、CI 和 maintainer 权限。一份好的贡献不只是“本地能跑”的补丁，而是范围清楚、有
证据、PR 可审查、并且没有把私有上下文泄漏进公开仓库的补丁。

这条路径是本仓库的贡献合同。开 PR 前先读它；让任何帮你开发的 coding agent 也先读它。

## 贡献路径

1. 准备源码 checkout，并使用 branch 或 worktree。
2. 把改动控制在一个可审查的范围内。
3. 运行与范围匹配的检查。
4. 用完整双语模板开 PR。
5. 处理 review comment 和 CI 失败。
6. 等 maintainer 控制的合入路径。

最后一步很重要：外部贡献者和他们的 agent 可以提出改动，但不能把改动合入 `main`。
合入权属于 maintainer、仓库 owner，或 maintainer 授权的 admin agent，并且必须在
required gates 通过之后执行。

## 这条路径覆盖什么

- [本地准备](01-local-setup.md)：运行时、安装姿态、branch 纪律、公开/私有文件边界。
- [改动流程](02-change-flow.md)：如何把贡献做成可审查、可测试的形状。
- [CI 与证据](03-ci-and-evidence.md)：本地命令、CI lane、测试分层、PR 证据。
- [PR、审查与合入](04-pr-review-and-merge.md)：PR 模板、review evidence、bot
  comment triage、合入权限。
- [Agent 贡献者](05-agent-contributors.md)：参与本仓开发的 coding agent 必须遵守的规则。

## 只进入公开范围

公开贡献应该落在公开 monorepo：`packages/`、`tools/`、`.github/`、根配置、根
README、package README，以及 `docs-release/`。

不要提交本地计划记录、私有证据目录、生成缓存、本地 agent 入口文件、凭证、绝对文件系统路径，
或机器特有状态。如果某条私有笔记帮你做了判断，请把可公开的推理摘要写进 PR，而不是复制私有笔记。

## Release 姿态

当前公开 release 姿态是源码 checkout 和 package smoke，不是已发布 npm 包，也不是已签名的
桌面产物。修改安装、打包、发布措辞前，先读
[Release Posture](../../release-posture.md)，确保文档诚实区分 shipped、
foundation-only 和 planned。

## 简短版

做一个最小且完整的改动，用正确检查证明它，如实填 PR 模板，把合入控制权留给 maintainer。
如果你的 agent 讲不清范围、验证和合入边界，它还没准备好开 PR。
