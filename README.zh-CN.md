<div align="center">

# Harness Anything

**每一次 agent 运行，都应该让你的仓库变得更聪明。**

Harness Anything 是一个会自我进化的 harness，也让你的仓库持续自我进化。
它把决定、失败、事实和评审沉淀成长期项目记忆，再用门禁约束“完成”，
让每一次进展产生复利，而不是随着聊天窗口一起蒸发。

<p>
  <a href="#快速开始"><b>运行 Demo</b></a> ·
  <a href="#为什么会产生复利">为什么会产生复利</a> ·
  <a href="#它如何工作">它如何工作</a> ·
  <a href="#文档">文档</a>
</p>

<p>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/FairladyZ625/harness-anything?style=flat&logo=github&color=yellow"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-brightgreen">
  <a href="./LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20%26%20unstable-orange">
</p>

<p>
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

</div>

![Harness Anything 桌面 GUI：Aurora Commerce 的 Task、Decision 与 Fact 产品组合](./docs-release/assets/harness-gui.gif)

---

## 你的 agent 会写代码，但你的项目会学习吗？

大多数 agent 运行都是一次性的：推理留在聊天记录里，已经定下的决定被反复重议，
同一种错误一再出现，而“做完了”只是 agent 自己的一句话。

Harness Anything 让这些工作真正积累下来：

| 没有 harness | 使用 Harness Anything |
| --- | --- |
| 推理随着会话结束而消失 | 决定与事实成为长期项目记忆 |
| 下一个 agent 重复过去的错误 | 失败可以沉淀成规则、检查与更好的工作流 |
| 完成只是一句声明 | 完成是通过门禁后才能到达的状态 |

它不是一个更漂亮的聊天记录，而是一套让仓库持续进化的复利循环。

## 为什么会产生复利

```text
决定 → 工作 → 验证 → 学习 → 下一次运行从更高的起点开始
```

### 记忆不会随着会话消失

每个任务都会留下真正重要的上下文：做了什么决定，尝试过什么，看到了什么，
还有哪些问题没有解决。下一个 agent 从项目记忆开始，而不是从头猜测历史。

### 错误会变成基础设施

一次失败不应该白白浪费。把它记录成事实，把反复出现的教训变成决定、检查或 preset，
仓库就会越来越难以用同一种方式再次出错。

### “完成”终于有了含义

Agent 不能只靠自信关闭任务。六字段 Submission Packet 先给 reviewer 留下可追溯的
完成声明与检查入口；reviewer 再记录检查了什么，以及为什么接受或拒绝这一轮交付。
最后，completion 只执行该 task 解析出的 preset/profile 契约所声明的门。coding 契约
可以要求 CI，但 kernel 不会把 CI 或最低 Fact 数量提升为全局门（依据
`dec_mrg3z1we/CH1`、`CH4` 与 ADR-0027 D5-D7）。

## Self-Involving：先用自己改造自己

Harness Anything 本身，就是通过 Harness Anything 开发的。

它自己的任务、决定、事实、评审和完成门禁，都运行在它交给其他仓库的同一套系统里。
Harness 会观察自己的失败，把教训变成更强的约束，再把这些约束用于下一轮开发。

这就是这里所说的“自我进化”：不是魔法，也不是不受控制的自动修改；
而是每完成一次循环，系统都比上一次更有能力做好下一次。你的仓库也会获得同样的复利机制。

## 快速开始

Harness Anything 目前从源码 checkout 运行，需要 Node.js 24+。先运行 30 秒 smoke demo：

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run quickstart:demo
```

Demo 会构建 CLI、创建一个临时项目、跑通一条真实任务循环，并展示 agent 工作结束后
真正留在仓库里的记录。

### 让你的 agent 帮你装

你不需要先学会 CLI。在你想接入 harness 的仓库里，把这一段 prompt 粘给你的
coding agent（Claude Code、Codex 或同类工具）：

```text
Install the harness-install skill from
https://github.com/FairladyZ625/harness-anything/tree/main/skills/harness-install
into your skills directory, then follow it to install Harness Anything into
this repository and verify the init flow end to end.
```

这个 skill 会带着 agent 走完全程：安装包、执行带归属的 `ha init`、启动
daemon、创建第一条真实任务——最后用完成门拒绝一次没有证据的「做完了」来证明
安装成功。被拒绝就是成功信号：你的仓库从此分得清「声称完成」和「验证完成」。

想深入了解？继续阅读[上手指南](./docs-release/start/zh/00-what-is-this.md)。

## 它如何工作

Harness Anything 用三个长期存在的原语承载 agent 工作：

- **Decision（决定）**：选择了什么，拒绝了什么，为什么。
- **Task（任务）**：正在改变什么，以及它的计划、进展、评审与收尾。
- **Fact（事实）**：真正观察到了什么，附带来源与置信度。

它们以纯 Markdown 的形式存在于一个私有嵌套 git 台账中。Git 保存历史，
可重建的投影让记录可以被查询，门禁则控制哪些状态转换能够发生。

最终，你的仓库记住的不再只有代码：

- 它的架构为什么会变成今天这样；
- 哪些尝试失败过，不应该再重复；
- 哪些工作真的完成了，哪些声明仍然悬而未决；
- 下一轮开发应该如何做得更好。

## 文档

- [上手（Start）](./docs-release/start/zh/00-what-is-this.md)：安装并跑通一条真实循环。（[English](./docs-release/start/en/00-what-is-this.md)）
- [理解（Learn）](./docs-release/learn/zh/00-overview.md)：理解记忆模型、门禁与复利循环。（[English](./docs-release/learn/en/00-overview.md)）
- [架构（Architecture）](./docs-release/architecture/zh/00-overview.md)：了解内核、存储模型、写入路径与投影。（[English](./docs-release/architecture/en/00-overview.md)）
- [发布态势](./docs-release/release-posture.md)：查看哪些能力已经发布、仍是基础设施或尚在规划。
- [GUI 示例项目](./examples/minimal-project/)：体验包含 40 个 Task、5 个 Decision 与 10 个 Fact 的真实产品组合。

## 贡献

当前尤其欢迎尖锐的 bug report、可复现的失败测试、架构问题和聚焦的文档修正。
提交 pull request 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

[AGPL-3.0-or-later](./LICENSE)。Harness Anything 保持开源，包括有人把它作为服务提供时。
