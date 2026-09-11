# 你的第一个循环

在一个临时 git 仓库里端到端运行这个。几分钟内你会有一个真实任务、一个事实和一个裁决的决策——全部是私有 `harness/` 账本里的 Markdown。下面的每个输出都从一次实际运行中捕捉下来。

## 0. 设置写入归属

本地 `ha` 写命令由已认证的 daemon 归属。初始化工作区时声明人类身份，并设置 commit
author 变量：

```bash
export HARNESS_GIT_AUTHOR_NAME="Your Name"
export HARNESS_GIT_AUTHOR_EMAIL="you@example.com"
ha init --person-id you --display-name "Your Name"
```

接下来使用普通的 `ha` 命令。daemon 会认证本地 socket 所有者并记录已配置的人；不要
`export HARNESS_ACTOR=human:you`。agent 自动化可按命令使用 `HARNESS_ACTOR=agent:<id>`。
完整 source 矩阵见[归属模型](../../actor-attribution.zh-CN.md)。

## 1. 初始化

```bash
$ ha init --person-id you --display-name "Your Name"
ok command=init path=harness/harness.yaml summary="initialized harness at harness/harness.yaml"
```

这会创建已撰写的 `harness/` 目录。你的任务、决策和标准住在这里，但不进入你的项目 git 仓。`ha init` 会把 `harness/` 加进外层 `.gitignore`，并把 `harness/` 初始化成独立的私有嵌套 git 仓。

这种隔离是防泄漏设计：代码 PR 不应包含 `harness/` 变更。需要给私有账本做版本记录时，在 `harness/` 里面提交：

```bash
git -C harness status
git -C harness add .
git -C harness -c user.name="$HARNESS_GIT_AUTHOR_NAME" \
  -c user.email="$HARNESS_GIT_AUTHOR_EMAIL" \
  commit -m "docs: update harness ledger"
```

生成的 `.harness/` 缓存只留在本地，也不会进入外层项目 git 仓。

```text
harness/
├── harness.yaml
├── adr/
├── context/
├── milestones/
├── standards/
└── tasks/
```

## 2. 创建一个任务

```bash
$ ha task create --title "Fix login redirect bug"
ok command="task create" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=planned
   path=harness/tasks/task_01KWPP52D...-fix-login-redirect-bug
```

你得到一个稳定的 `task_<id>` 和一个磁盘上的任务包。ID 是身份；标题只是显示元数据。

## 3. 贯穿生命周期移动

```bash
$ ha task transition task_01KWPP52D062Q7BWTD8BCNDRWF active
ok command="task transition" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=active
   summary="set task task_01KWPP52D062Q7BWTD8BCNDRWF to active"
```

任务经历六个状态：`planned → active → blocked → in_review → done → cancelled`。`done` 和 `cancelled` 是终态。

## 4. 记录一个事实，然后一个决策

事实是只增不改的观察。若要把观察归属到 task 并生成 `produces` 边，加上 `--task`：

```bash
$ ha fact record --task task_01KWPP52D062Q7BWTD8BCNDRWF \
    --statement "Redirect loops when the session cookie is missing" \
    --source "manual repro" --confidence high
ok command="fact record" fact=F-7K3M2Q9R path=facts/F-7K3M2Q9R.md
```

现在提议一个决策——为什么——并裁决它：

```bash
$ ha decision propose --title "Use a server-side redirect guard" \
    --question "How do we stop the login redirect loop?" \
    --chosen "Add a server-side guard" \
    --rejected "Client-only fix" \
    --why-not "Client fix races with cookie set"
ok command="decision propose" path=harness/decisions/decision-dec_mr6f3b4z/decision.md

$ ha decision accept dec_mr6f3b4z --arbiter you
ok command="decision accept" path=harness/decisions/decision-dec_mr6f3b4z/decision.md
```

`accept` 是裁决检查点：决策的证据关系（用提议时的 `--evidence-relation` 附加，或稍后用 `ha decision relate`）在决策变为有约束力前被验证。这就是为什么一个被接受的决策*可信*而不只是被声称——完整的失败-闭合策略在 **[learn/](../../learn/zh/00-overview.md)** 里覆盖。

## 5. 看结构增长

```bash
$ ha status
ok command=status path=.harness/cache/projections.sqlite rows=1

$ ha graph
ok command=graph path=.harness/generated/graph-panorama/index.html
```

`graph` 把你的任务、决策和事实渲染成自包含 HTML 全景，全部有链接。

**这就是啊哈时刻**：你产生的不是聊天记录。它是私有 `harness/` 账本里的真实、版本化结构——任务、它观察到的事实和它说明的决策，全部有链接，并且可以用 `git -C harness diff` 审查。

![demo](../assets/demo.gif)

> **GIF 即将上线**——等 GUI 上船后替换为实时片段。

---

下一步：更深入探索*为什么* → **[learn/](../../learn/zh/00-overview.md)**，或抓住 **[日常命令速记表](03-daily-commands.md)**。
