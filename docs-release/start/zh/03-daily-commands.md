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

## 完整命令面

这个页面有目的地只覆盖高频子集。权威的、总是最新的参考是 CLI 本身：

```bash
ha --help              # 全局帮助，或：ha help <command>
ha capabilities        # 实体操作、输入 schema 和例子
```

弃用 alias 不再作为另一条工作流记录；请使用当前 help 和完整闭环页展示的形式。
