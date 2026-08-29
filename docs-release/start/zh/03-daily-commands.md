# 日常命令

你最常用命令的速记表。任何命令加 `--json` 得到结构化输出。

## 你会持续用的命令

| 命令 | 做什么 |
|---|---|
| `ha init` | 创建 `harness/` 账本布局及其私有嵌套 git 仓。 |
| `ha task create --title <title>` | 创建一个新任务包。 |
| `ha task list` | 列出任务包，带状态/模块/搜索过滤。 |
| `ha task show <id>` | 查看单个任务的投影状态、元数据、层级、关系边和事实锚。 |
| `ha task start <id>` | 通过派工关系门后取得 execution lease。 |
| `ha task relate <id> relates fact/F-XXXXXXXX --rationale <text>` | 把 task 关联到允许派工的 Fact。 |
| `ha task transition <id> <state>` | 把任务移到新的生命周期状态。 |
| `ha decision propose --title <t> ...` | 提议一个决策（问题、已选、已拒、为何不）。 |
| `ha decision accept <id>` | 裁决一个提议的决策——证据检查点。 |
| `ha fact record --statement <text> --source <text> [--task <id>]` | 记录一个只增不改的事实；可选关联到任务。 |
| `ha status` | 总结 harness 状态。 |
| `ha check` | 运行 harness 健康检查。 |
| `ha graph` | 把关系图渲染成自包含 HTML 全景。 |

## 按场景

**任务生命周期**
```bash
ha task create --title "Implement slice"
ha decision relate <decision-id> --anchor CH1 --type derives --target task/<id> --rationale "..."
# 或：ha task relate <id> relates fact/F-XXXXXXXX --rationale "..."
ha task start <id>
ha task progress append <id> --text "Implemented first slice"
```

在上述任一 active 关系边存在之前，`ha task start` 与
`ha runtime run <instance> --task <id>` 都会返回 `orphan_task`。拒绝回执会列出两种补边命令，
且不会给 task 上租约。

**决策**
```bash
ha decision propose --title "..." --question "..." --chosen "..." --rejected "..." --why-not "..."
ha decision accept <id>       # or: reject | defer
ha decision list --state active
```

**事实**
```bash
ha fact record --statement "..." --source "..." --confidence high [--task <id>]
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

一些旧的命令拼写仍然作为已弃用别名工作，会在未来发布中退役——优先用上面展示的形式。
