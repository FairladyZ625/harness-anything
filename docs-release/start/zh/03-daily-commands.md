# 日常命令

你最常用命令的速记表。任何命令加 `--json` 得到结构化输出。

完整可执行的 Fact → Decision → Task → Fact 顺序只保留在
[第一个完整闭环](02-first-loop.md)。本页不重复那条有状态工作流。

## 你会持续用的命令

| 命令 | 做什么 |
|---|---|
| `ha init` | 创建 `harness/` 账本布局及其私有嵌套 git 仓。 |
| `ha task create --title <title>` | 创建一个新任务包。加 `--work <id>` 把它归入一个工作。 |
| `ha task list` | 列出任务包，带状态/搜索/父任务过滤。 |
| `ha task show <id>` | 查看单个任务的投影状态、元数据、层级、关系边和事实锚。 |
| `ha task start <id>` | 取得或复用当前 execution lease。 |
| `ha status` | 总结 harness 状态。 |
| `ha check` | 运行 harness 健康检查。 |
| `ha graph` | 把关系图渲染成自包含 HTML 全景。 |

**组织工作**

一个*工作*是一个根任务加归入它的任务，也是给任务分组的唯一方式；不带 `--work` 的任务独立存在。

```bash
ha work create --title "Login hardening"      # 工作的根任务
ha task create --work <id> --title "Fix redirect loop"
ha work list                                  # 进行中的工作及进度；--all 列出全部
ha work show <id>                             # 目标、子树计数、未完成任务
ha agenda --work <id>                         # 只看这一个工作的议程
```

**检查和导航**
```bash
ha status          # 我在什么状态？
ha check           # 一切健康吗？
ha relation list --entity task/<id>
ha graph           # 可视化一切怎样链接
ha doctor          # 只读环境诊断
```

## 任务工作树

输出是仓库变更的任务，在某个节点上第一次启动（`ha task start`）或派工时获得自己的 Git 工作树。它由 Harness 管理，不需要执行任何工作树命令。

- **名字：** 分支 `<任务标识>`，目录 `.worktrees/<任务标识>`，与标题无关。
- **基线：** `origin/HEAD` 指向的远端默认分支；没有远端时取主检出的当前分支。启动回执会写明基线。
- **其他任务：** 不改仓库文件的任务没有工作树；`ha task show` 和 GUI 任务详情把它的工作区显示为任务包目录。

在 Settings 中声明新工作树需要的准备步骤。每一步是内置适配器 `node-modules` 或 `run: <命令>`；这些步骤在工作树内按顺序只运行一次，环境中带有 `HARNESS_TASK_ID`、`HARNESS_WORKTREE` 和 `HARNESS_REPO_ROOT`。

```bash
ha settings update --worktree-setup node-modules              # npm workspaces：镜像根目录 node_modules
ha settings update --worktree-setup "run: uv sync"            # Python（或 "run: pip install -e ."）
ha settings update --worktree-setup "run: make bootstrap"     # 任意单条命令
ha settings update --worktree-setup node-modules --worktree-setup "run: npm run build"  # 多步按顺序
ha settings update --worktree-setup none                      # 不做准备
ha settings read                                              # 显示 worktree.setup
```

`ha init` 检测到 npm workspaces 时写入 `node-modules`，并在回执中说明。GUI 仓库设置面板中也能编辑同一列表。

某一步失败时，工作树保留，启动或派工被拒绝。提示会写明失败的步骤和日志位置（工作树 Git 目录下的 `harness-setup/step-<n>.log`）。修复原因后再次执行同一个 `ha task start` 或派工，只有尚未成功的步骤会重跑。

旧命名（`codex/<slug>-<id8>`）下建立的工作树，由 `ha task contract migrate --apply` 一次性改名。有未提交改动或仍有在飞执行者的工作树不会被移动，而是列出来交给你处理。

## 完整命令面

这个页面有目的地只覆盖高频子集。权威的、总是最新的参考是 CLI 本身：

```bash
ha --help              # 全局帮助，或：ha help <command>
ha capabilities        # 实体操作、输入 schema 和例子
```

弃用 alias 不再作为另一条工作流记录；请使用当前 help 和完整闭环页展示的形式。
