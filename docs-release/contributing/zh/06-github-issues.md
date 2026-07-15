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

请使用仓库的 source-triaged issue form。普通贡献者的 blank issue 入口已关闭；绕过 form 创建的
issue 会被 issue intake workflow 关闭，直到按必填段落重新提交。

请包含：

- 期望行为；
- 实际行为；
- 复现步骤，尽量从干净源码 checkout 开始；
- 精确命令输出，或最小相关日志片段；
- 环境信息：OS、Node 版本、包管理器、分支或 commit；
- 如果知道，指出可能相关的文件或 package 区域；
- 是否由 agent 发现，或是否已有 agent 尝试修复。

如果 issue 是 agent 生成的，还要说明 agent 的证据边界：它读了什么、改了什么、跑了哪些检查、
哪些检查没有跑。

## 必填源码级 triage

每个 issue 都必须包含源码级 triage。不要假设 maintainer 和 reporter 使用同一个操作系统、shell、
文件系统、工具链或 agent runtime。issue 应给出足够的公开证据，让 maintainer 即使无法运行
reporter 的完全相同环境，也能优先检查可能的源码边界。

请包含：

- 真实环境输出：命令、退出码、相关 stdout 或 stderr、OS、shell、Node 版本、包管理器、分支或
  commit；
- 生成文件或日志的关键片段，使用仓库相对路径，并隐去 secret 或私有数据；
- agent 检查过的相关源码区域，例如看起来控制失败行为的文件、函数、schema 或 contract；
- agent 读了什么，包括公开文档、源码文件、生成产物，以及用于诊断的 issue 或 PR 上下文；
- 源码级假设：可能失败的是哪条数据流、路径处理、命令契约或平台假设；
- 建议修复目标，例如 maintainer 应优先调查的文件、函数、contract、校验规则或测试用例；
- 已经运行的检查、没有运行的检查，以及跳过相关检查的原因。

reporter 的 agent 不是最终修复方案的权威来源。它给出的修复建议是必填的方向输入，用来帮助
maintainer 定位可能的源码边界；maintainer 读源码后可以选择不同实现。

## 适合 agent 修复的 issue 形状

好的 issue 会给 agent 一条窄的修复路径：

- 一个具体问题，不把不相关症状打包在一起；
- 只链接公开文件；
- 不包含本机绝对路径、secret、私有笔记或生成缓存；
- 有清楚的 stop condition，例如“这个命令退出 0”或“页面链接到新的贡献步骤”；
- 写明实现前是否需要 maintainer 决策。

如果 issue 还不能直接实现，请写“需要 maintainer 决策”或“需要先复现”，不要让 agent 猜。

## 修复流程

maintainer 或授权 agent 可以在创建 task 时选择内置 GitHub issue repair preset：

```bash
ha task create --title "Repair issue <number>" \
  --vertical software/coding \
  --preset github-issue-repair
```

这个 preset 是给 agent 的工作指引，不是 GitHub client，也不运行 headless intake 脚本。
agent 使用自己的已认证 `gh` 权限读取当前 issue，例如
`gh issue view <number> --repo <owner/name>`，再通过普通 task 工作流记录 issue 引用、
复现证据、修复范围、验证结果和未决问题。如果 issue 有歧义、无法复现或需要 maintainer
裁决，agent 应停下来询问，不得自行补造缺失意图。preset 不会合并代码、绕过 review，
也不会替代 PR 模板。

## 修复之后

PR 应引用对应 issue，说明范围，包含验证证据，并把合入权限留给 maintainer。如果修复改变了 issue
原来的假设，请在 PR body 里说明，不要静默扩大范围。
