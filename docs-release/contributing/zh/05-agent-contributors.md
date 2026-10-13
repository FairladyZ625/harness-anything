# Agent 贡献者

Coding agent 与人类遵守同一份公开贡献合同。加载
[`harness-contributing`](../../../skills/harness-contributing/SKILL.md) 并执行完整序列；
不要从本页推导一条 agent 专用捷径。

## 两种发布模型

本页与 `harness-contributing` skill 描述的是其中一种模型：agent 用操作者自己的
Git 凭据做贡献——自己 push contribution branch、自己开 PR。另一种模型是已注册
Harness 工作区内被派工的任务绑定 worker：它不持有个人 Git 凭据，经 daemon 用
`ha task push`、`ha task pr`、`ha task ci` 发布，direct-push 保护把任何推送都限制在
本任务自己的分支上。见
[任务分支发布](../../operations-server-daemon.zh-CN.md#任务分支发布与-direct-push-保护)。

两种模型共享同一条边界：合入归 maintainer。

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
