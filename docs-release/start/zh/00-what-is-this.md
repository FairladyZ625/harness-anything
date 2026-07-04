# 这是什么？

Harness Anything 把你的 AI 代理产生的**决策(decision)、任务(task)和事实(fact)**变成 git 上的一等公民记录——可查询、可回滚、可重用——而不是丢失在聊天记录里。

运行一条命令，结构就开始在你的仓库里积累：

```text
$ ha task create --title "Fix login redirect bug"
ok command="task create" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=planned
   path=harness/tasks/task_01KWPP52D...-fix-login-redirect-bug

$ ha status
ok command=status path=.harness/cache/projections.sqlite rows=1
```

每个任务、每个决策、每条记录的事实都落地为纯 Markdown，你可以在普通 git diff 里审查。

![demo](../assets/demo.gif)

> **GIF 即将上线**——等 GUI 上船后，这里会有一段运行一个循环、看结构增长的短视频。在那之前，上面的静态命令顶替。

**三件要点：**

- 它解决了*"推理去哪了？"*的问题——代理工作不再蒸发到日志里。
- 和笔记不同，这些是结构化、有链接的记录且有生命周期：决策可以被推翻，事实锚定到产生它们的任务。
- 想试试？ → **[安装](01-install.md)**
