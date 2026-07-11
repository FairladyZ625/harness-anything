# Harness Anything

> **你的 agent 说做完了。让它拿出证据。**

Harness Anything 是 AI agent 的问责层（accountability layer）：agent 产出的每
一个决定、任务、事实，都变成 git 里可审计的结构——而 `done` 必须带着证据
过门禁。

你没法靠一句更好的 prompt 阻止 agent 在当下抄近路。真正有用的是人类一直
在用的老办法：**摄像头和后果。**把每个 claim 放进永久记录，给出口加门禁，
让虚假的“完成”无法维持。我们在自用（self-involving）中看到的是：没有门禁
的路径会被 100% 旁路。没有 gate，就等于一定被绕过。

## 先跑 30 秒证明

当前公开路径仍然是源码 checkout。现在还没有公开 npm package，所以不要把
`npx harness-anything init` 当成今天可用的公开入口。

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run quickstart:demo
```

这条 smoke 会构建 CLI、初始化一个临时 git workspace、创建 task、记录可查询
的 fact，并渲染 relation graph。如果承重步骤拿不出证据，流程会 fail closed，
而不是假装已经完成。

生命周期 gate 是真实存在的。在本地源码构建里，一个 task 不能靠宣告被硬塞进
`done`：

```console
$ ha task transition task_01KWX5RBJQMEZ2T7AR6GFB8Q6K done
error code=terminal_status_requires_task_complete
```

一次 Execution 提交会写入六个字段：completion claim、deliverables、Evidence refs
（`0..N`）、verification notes、known gaps 与 residual risks；只有一段文字的提交也
合法。`OutputEvidence` 可用 inline、file、URL、object 或 entity locator。机械校验只
检查 locator 完整性、来源/归属、可选 digest 与可选 checker receipt 的绑定；相关性与
充分性只能由 reviewer 判断，并记录 `evidence_checked` 与 rationale（依据
`dec_mrg3z1we/CH1-CH3`、ADR-0027 D3、D5-D6）。

`ha task complete` 从 task 选中的 preset/profile 解析确定性门。内置 coding profile
声明了 CI 与 code-doc reconciliation，所以 coding completion 传 `--ci passed`；
`--ci` 不再是全局必填。带 Execution 的任务还必须有 approved Review。任何路径都不
要求最低 Fact 数量：Fact 是 `0..N` 的显式晋升，submit、review 或 complete 都不会
自动生成 Fact（依据 `dec_mrg3z1we/CH4`、ADR-0027 D7）。

等 0.1 package 发布到 npm 之后，初见入口会变成：

```bash
npx harness-anything init
```

在发布真正存在之前，请使用上面的源码路径，或构建后用
`npm install -g ./packages/cli` 安装本地 `ha`。

## 三个原语

- **decision** ——为什么。一个选择、替代方案、理由和明确 arbiter。决策可以
  被推翻，但不能被抹掉。
- **task** ——做什么。一个单位工作跨越六态生命周期，`done` 被 completion
  gate 锁住。
- **fact** ——长期观察。它是可选的、只增不改的显式晋升，锚定到产生它的 task；交付
  Evidence 留在 Execution 上（依据 `dec_mrg3z1we/CH2`、`CH4`）。

`ha` CLI 把纯 Markdown 写入你的 git 仓库，并维护可重建的 SQLite 投影以快速
查询。可以 grep，可以 diff，也可以在 PR 里 review。

---

## 从这里开始

先跑 smoke demo，再走第一个真实循环。

→ **[start/](start/zh/00-what-is-this.md)**

## 贡献时不要绕过门禁

想帮忙构建 Harness Anything，或把 agent 指向这个仓库？先读贡献路径：本地
准备、改动流程、CI 证据、PR 审查、合入权限，以及 agent 专用规则。

→ **[contributing/](contributing/zh/00-overview.md)**

## 理解为什么这样设计

设计是有意为之。这条路径讲解原语内核、决策裁决、gate、扩展模型和采用律。

→ **[learn/](learn/zh/00-overview.md)**

## 看它到底是怎么建的

读完 `learn/`，好奇系统到底如何兑现那些主张？这条路径讲机制：存储、写入
路径、投影、gate、来源追踪以及 vertical 引擎。

→ **[architecture/](architecture/zh/00-overview.md)**

## 检查发布状态边界

在公开文档里使用 release、GUI、daemon、remote、adapter 或 packaging 相关表述之前，先检查唯一状态权威。

→ **[release-posture.zh-CN.md](release-posture.zh-CN.md)**

## 理解 daemon 边界

daemon 文档说明当前运维形态和限制：本地 daemon 服务管理、仓库注册、direct-push 保护、只读镜像，以及 remote 边界。

→ **[operations-server-daemon.zh-CN.md](operations-server-daemon.zh-CN.md)**

## 正确标注每一次写入的归属

human、agent、system、本地 CLI 与已认证 daemon 并不走同一条身份通道。配置 shell 或团队
自动化之前，先读归属模型。

→ **[actor-attribution.zh-CN.md](actor-attribution.zh-CN.md)**
