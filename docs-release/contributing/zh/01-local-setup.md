# 本地准备

标准前置条件、clone 命令和 worktree 序列统一放在
[Environment and worktree](../../../skills/harness-contributing/SKILL.md#environment-and-worktree)。
每份贡献都直接按该序列执行，不要从本页另写一套 setup recipe。

## 为什么必须使用独立 worktree

primary checkout 是协调点，不是实现 surface。每份贡献只占一个 worktree，可以明确
branch ownership、隔离并发的人或 agent，并让最终公开 diff 对应单一 scope。即使代码
本身正确，共用或已有脏改动的 worktree 也会破坏这条证据链。

## 公开 checkout 边界

贡献 checkout 可以包含公开源码、测试、工具、CI、fixture、example 和 release 文档。
本地规划、agent runtime 状态、cache、凭证、私有 URL、本机绝对路径和无关改动都不是
公开贡献材料。具体执行以 skill 的边界说明和 staged-diff 检查为准。

使用产品和修改本仓库是两件事。源码使用路径见
[Start / Install](../../start/zh/01-install.md)；修改本仓库时使用贡献 skill。
