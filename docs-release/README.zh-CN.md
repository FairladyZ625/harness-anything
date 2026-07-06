# Harness Anything

> **你的 agent 说做完了。让它拿出证据。**

Harness Anything 是 AI agent 的问责层（accountability layer）：agent 产出的每一个决定、任务、事实，都变成 git 里可审计的结构——而"做完了"必须带着证据过门禁。

三个原语，全部在你的仓库里版本化：

- **decision** ——为什么。一个选择、它的替代方案和证据。可回滚。
- **task** ——做什么。一个单位工作跨越六态生命周期。
- **fact** ——是什么。一个只增不改的观察，锚定到产生它的任务。

`ha` CLI 是你今天用的工具。它把纯 Markdown 写入你的 git 仓库，并维护可重建的 SQLite 投影以快速查询。

---

## 快速上手

装好它，运行一个真实循环，看结构增长，自己体验它的价值——大约 10 分钟。

→ **[start/](start/zh/00-what-is-this.md)**

## 贡献时不要绕过门禁

想帮忙构建 Harness Anything，或把 agent 指向这个仓库？先读贡献路径：本地准备、改动流程、CI 证据、PR 审查、合入权限，以及 agent 专用规则。

→ **[contributing/](contributing/zh/00-overview.md)**

## 理解为什么这样设计

设计是深思熟虑的，每个选择都有理由。这条路径讲解原语内核、决策和裁决机制、守门人(gate)、扩展模型和方法论。

→ **[learn/](learn/zh/00-overview.md)**

## 看它到底是怎么建的

读完 `learn/`，好奇*系统到底如何兑现那些主张*？这条路径讲机制：分层架构、三个实体如何落在磁盘上、单一写入路径、可重建的 SQLite 投影、守门人(gate)以及 vertical 引擎。

→ **[architecture/](architecture/zh/00-overview.md)**
