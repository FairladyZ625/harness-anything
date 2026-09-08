# 这是什么？

> **你的 agent 说做完了。让它拿出证据。**

Harness Anything 是 AI agent 的问责层（accountability layer）。它把你的
agent 产生的**决策（decision）、任务（task）和事实（fact）**变成隔离的私有
账本 git 仓里的一级记录——可查询、可回滚、可重用——而不是丢失在聊天记录里。

重点不是把笔记记得更漂亮。Agent 很擅长做事，却很不擅长为自己的工作负责：
它们会忘记上下文，会偏离已经定下的决策，也会因为你无法手工检查每件事而
直接宣布胜利。更好的 prompt 解决不了这个问题。真正有用的是人类一直在用的
办法：**摄像头和后果。**

把每个 claim 放进永久记录，给出口加 gate，让虚假的 `done` 无法维持。我们
在自用（self-involving）中看到的是：没有门禁的路径会被 100% 旁路。没有
gate，就等于一定被绕过。

## 先看 30 秒证明

0.0.1 CLI 候选版可以从本地 npm tarball 安装。今天最快的路径仍是源码 checkout smoke demo：

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run quickstart:demo
```

这条命令会构建 CLI、初始化一个临时 git workspace、创建 task、记录可查询的
fact，并渲染 relation graph。承重步骤如果拿不出证据，会 fail closed，而不
是静默放行。

等 package 正式发布到 registry 后，可安装 scoped package 并直接运行不带参数的 `ha init`。在那之前，
请使用本地 tarball 或上面的源码路径。

## 什么会落到磁盘上

运行 CLI，结构就开始在 `harness/` 下积累：

```text
$ ha task create --title "Fix login redirect bug"
ok command="task create" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=planned
   path=harness/tasks/task_01KWPP52D...-fix-login-redirect-bug

$ ha status
ok command=status path=.harness/cache/projections.sqlite rows=1
```

每个任务、每个决策、每条记录的事实都以纯 Markdown 落在 `harness/` 里。
这个目录是独立的私有嵌套 git 仓，所以审查账本 diff 要用 `git -C harness diff`，
不是外层项目仓的 git diff。

![demo](../assets/demo.gif)

> **GIF 即将上线**——等 GUI 上船后，这里会有一段运行一个循环、看结构增长
> 的短视频。在那之前，上面的静态命令和 smoke demo 顶替。

**三件要点：**

- 它解决了*"推理去哪了？"*的问题——代理工作不再蒸发到日志里。
- 和笔记不同，这些是结构化、有链接、带生命周期的记录：决策可以被推翻，
  task 要过 gate，事实锚定到观察到它们的任务。
- 想试试？ → **[安装](01-install.md)**
