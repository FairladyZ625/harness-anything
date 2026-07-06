# Agent 贡献者

欢迎把 coding agent 当成实现助手，但 agent 必须遵守和人类一样的公开贡献合同。一个能改文件却不能遵守 scope、
evidence 和合入权限的 agent，还没准备好在这个仓库工作。

## 给 agent 的最小读集

至少把这些材料交给 agent：

- 这套 contributing 文档；
- root README 和 `docs-release/`；
- `.github/pull_request_template.md`；
- task 或 issue 点名的具体文件；
- `package.json` 里的 package scripts；
- changed code 旁边的相关测试。

如果代码涉及 library、framework、SDK、CLI 或 cloud service，agent 应查阅当前官方文档，而不是只依赖记忆。

## Agent 基本规则

agent 必须：

- 编辑前说明 task scope；
- 在 branch 或 worktree 上工作，不在共享 `main` 上工作；
- 提抽象前先读当前代码；
- 把编辑控制在声明范围内；
- 使用现有 package boundary 和 helper；
- 运行相关检查并报告精确结果；
- 保留无关本地改动；
- 只 stage 本任务修改的文件；
- 不把私有笔记、本地路径或凭证放进公开 diff。

agent 不得：

- 在 release boundary 要求前，为假想用户加兼容 shim；
- 为了风格重写无关文件；
- 绕过 generated gates，或删除失败测试来让 CI 变绿；
- 用空 verification section 开 PR；
- merge、force-push 或 direct-push 到 `main`，除非 maintainer 对该具体操作明确授权。

## Agent 创建 task 与证据

如果 maintainer 要求 agent 使用 Harness Anything task records，agent 应使用当前 CLI：

```bash
ha task create --title "<title>" --vertical software/coding --preset standard-task
ha task progress append <task-id> --text "<progress>"
ha fact record --task <task-id> --statement "<observed fact>" --source "<source>" --confidence high
```

不要手工 scaffold task 目录。如果 CLI 不能创建或更新 task package，停下来报告 blocker。

## Agent PR handoff

请求 review 前，agent 应留下紧凑 handoff：

- 改了什么；
- 没改什么；
- 跑了哪些命令；
- 哪些命令没跑，为什么；
- 已知 residual risk；
- 需要人重点看的文件。

这份 handoff 应放进 PR body 或 review comment，而不是放在 reviewer 看不到的私有本地笔记里。

## Agent 的合入边界

外部贡献者的 agent 只有 proposal authority。它可以建 branch、commit、跑检查、开或更新 PR。它不能决定
PR 是否允许进入 `main`。

只有 maintainer、owner 或 maintainer 授权的 admin agent 可以合入，并且必须满足这套文档里的 CI 与 review gates。
