# 这是什么？

> **你的 agent 说做完了。让它拿出证据。**

Harness Anything 是 AI agent 的问责层（accountability layer）。它把你的
agent 产生的**决策(decision)、任务(task)和事实(fact)**变成 git 上的一等公民
记录——可查询、可回滚、可重用——而不是丢失在聊天记录里。

重点不是把笔记记得更漂亮。Agent 很擅长做事，却很不擅长为自己的工作负责：
它们会忘记上下文，会偏离已经定下的决策，也会因为你无法手工检查每件事而
直接宣布胜利。更好的 prompt 解决不了这个问题。真正有用的是人类一直在用的
办法：**摄像头和后果。**

把每个 claim 放进永久记录，给出口加 gate，让虚假的 `done` 无法维持。我们
在 dogfood 里看到的是：没有门禁的路径会被 100% 旁路。没有 gate，就等于
一定被绕过。

## 先看 30 秒证明

目前还没有公开 npm package。今天最快的路径是源码 checkout smoke demo：

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run quickstart:demo
```

这条命令会构建 CLI、初始化一个临时 git workspace、创建 task、记录可查询的
fact，并渲染 relation graph。承重步骤如果拿不出证据，会 fail closed，而不
是静默放行。

等 0.1 package 发布到 npm 之后，初见命令会变成 `npx harness-anything init`。在那之前，
请继续使用上面的源码 checkout 路径。

## 什么会落进你的仓库

运行 CLI，结构就开始在你的仓库里积累：

```text
$ ha task create --title "Fix login redirect bug"
ok command="task create" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=planned
   path=harness/tasks/task_01KWPP52D...-fix-login-redirect-bug

$ ha status
ok command=status path=.harness/cache/projections.sqlite rows=1
```

每个任务、每个决策、每条记录的事实都落地为纯 Markdown，你可以在普通 git diff 里审查。

![demo](../assets/demo.gif)

> **GIF 即将上线**——等 GUI 上船后，这里会有一段运行一个循环、看结构增长
> 的短视频。在那之前，上面的静态命令和 smoke demo 顶替。

**三件要点：**

- 它解决了*"推理去哪了？"*的问题——代理工作不再蒸发到日志里。
- 和笔记不同，这些是结构化、有链接、带生命周期的记录：决策可以被推翻，
  task 要过 gate，事实锚定到观察到它们的任务。
- 想试试？ → **[安装](01-install.md)**
