# 提 GitHub issue

GitHub issue 是公开接收 bug、文档缺口和小范围改进的入口。issue 要写到
maintainer 或 coding agent 尽可能可以复现问题，并且始终能根据公开的源码级证据判断可能的源码边界。

## 什么时候提 issue

这些情况适合提 issue：

- 可复现的 bug；
- 文档缺口，或公开措辞容易误导；
- 有清晰用户可见结果的小改进；
- 命令或 CI lane 失败，并且有足够日志可以调查。

不要把凭证、私有 harness 记录、本地计划、或宽泛 roadmap 讨论放进 issue。如果报告依赖私有信息，
请只总结公开症状，并说明哪些内容不能公开。

## issue 必须包含什么

请使用仓库的 source-triaged issue form。普通贡献者的 blank issue 入口已关闭。如果缺少必填段，
issue intake workflow 会评论列出缺失的段，但不会关闭 issue，你可以直接编辑补齐。

每个 issue 都包含这些段：

| 段落 | 要写什么 |
| --- | --- |
| Issue type | 从 Bug、Documentation gap、Scoped improvement、Failing command or CI lane 中选一个。 |
| Impact | 谁受影响、发生频率、坏了什么、有没有 workaround、波及面有多大。 |
| Expected behavior | 应该发生什么。 |
| Actual behavior | 实际发生了什么。 |
| Reproduction steps | 从干净源码 checkout 开始的最小有序步骤，包含精确命令与退出码。 |
| Version / build | `ha --version`、daemon 的 build 或 `commit=`、仓库分支或 commit、相关 npm 包版本，以及 agent/runtime 版本。OS 与 shell 写在 Reporter environment。 |
| Screenshot or recording | 有可见证据时提供。没有时写 `Not applicable — text evidence in Command output or logs`，不要贴无关截图。 |
| Command output or logs | 精确命令、退出码，以及最小相关 stdout/stderr 或日志片段，并隐去 secret。 |
| Reporter environment | OS、shell、Node 版本、包管理器、分支或 commit，以及涉及的 agent/runtime。 |
| Source-level triage | 读过的公开文件与 contract、源码级假设、应先查哪里、已跑的检查，以及没跑的检查和原因。 |
| Stop condition or acceptance criteria | 可观察的修复条件，或实现前需要的 maintainer 决策。 |
| Public issue checklist | 确认已移除私有数据、写有源码级 triage，并且 Impact 写清了受影响用户、频率与波及面。 |

## 源码级 triage

源码级证据让 maintainer 即使无法运行 reporter 的完全相同环境，也能优先检查可能的源码边界。
不要假设 maintainer 和 reporter 使用同一个操作系统、shell、文件系统、工具链或 agent runtime。

请在同一段 Source-level triage 里写清五件事：

- 读过的公开文件、函数、schema、contract、生成产物或文档，使用仓库相对路径；
- 源码级假设：可能失败的是哪条数据流、路径处理、命令契约、平台假设或校验规则；
- maintainer 应优先调查的文件、函数、contract、校验规则或测试用例；
- 已经运行的检查及其结果；
- 没有运行的检查，以及跳过相关检查的原因。

reporter 的 agent 不是最终修复方案的权威来源。它给出的修复建议是方向输入，用来帮助
maintainer 定位可能的源码边界；maintainer 读源码后可以选择不同实现。

## agent 如何提 issue

agent 把一次发现转成公开 issue 时，走
[`skills/harness-issue/SKILL.md`](../../../skills/harness-issue/SKILL.md)。这条路径依次完成
取证、canonical body、脱敏、heading 自查，以及 `gh issue create --body-file`。issue form
仍然是形状的唯一权威；skill 不替代它。

## 适合 agent 修复的 issue 形状

好的 issue 会给 agent 一条窄的修复路径：

- 一个具体问题，不把不相关症状打包在一起；
- 只链接公开文件；
- 不包含本机绝对路径、secret、私有笔记或生成缓存；
- 有清楚的 stop condition，例如“这个命令退出 0”或“页面链接到新的贡献步骤”；
- 写明实现前是否需要 maintainer 决策。

如果 issue 还不能直接实现，请写“需要 maintainer 决策”或“需要先复现”，不要让 agent 猜。

## 修复流程

maintainer 或授权 agent 可以用内置 GitHub issue repair preset，把 issue 拉进 task 证据包：

```bash
ha preset action github-issue-repair plan \
  --task <task-id> \
  --allow-scripts \
  --input repo=FairladyZ625/harness-anything \
  --input issueJson=artifacts/issue-<number>.json
```

确定性 intake 应使用 `issueJson` 或 `fixtureFile`。如果要让 preset 发起 GitHub live request，
必须显式传入 `--input fetchMode=best-effort` 和 `--input issue=<number>`；preset sandbox
里的网络访问只是 best-effort。preset 会把结构化 repair intake 写到该 task 的 `artifacts/`
目录。它不会合并代码、绕过 review，也不会替代 PR 模板。

## 修复之后

issue 被接受实现后，继续执行本仓
[`harness-contributing`](../../../skills/harness-contributing/SKILL.md) skill。如果修复改变了
issue 原来的假设，应在 scope review 时明确说明，不要静默扩大贡献范围。
