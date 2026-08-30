# Agent 贡献者

Coding agent 与人类遵守同一份公开贡献合同。加载
[`harness-contributing`](../../../skills/harness-contributing/SKILL.md) 并执行完整序列；
不要从本页推导一条 agent 专用捷径。

## Agent 证据边界

agent 应在编辑前检查当前公开源码，持续显示声明 scope，保留无关改动，并报告精确命令与
结果。handoff 必须区分改了什么、没改什么、哪些检查通过、哪些未运行及原因、open
finding 和 residual risk。

agent 只能使用贡献任务实际授予的权限。它不得暴露本地上下文、绕过 generated gate、
删除失败测试来让 CI 变绿，也不得替别人声称 human review、Dashboard confirmation、
release decision 或 merge approval。

## Proposal authority

获得授权的 agent 可以准备 commit、push contribution branch、创建或更新 PR；不能直推
`main`、用 force-push 逃避失败检查，或自行决定 PR 可以合入。最终 handoff 必须明确说明
merge 仍由 maintainer 控制。
