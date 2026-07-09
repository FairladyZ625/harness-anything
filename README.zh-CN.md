<div align="center">

# Harness Anything

**你的 agent 说做完了。让它拿出证据。**

Harness Anything 是 AI agent 的问责层（accountability layer）：agent 产出的每一个
决定、任务、事实，都变成 git 里可审计的结构；而“做完了”必须带着证据过门禁。

<p>
  <a href="#快速开始">快速开始</a> ·
  <a href="#你会得到什么">你会得到什么</a> ·
  <a href="#文档">文档</a> ·
  <a href="#深入了解">深入了解</a> ·
  <a href="./CHANGELOG.md">CHANGELOG</a>
</p>

<p>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/FairladyZ625/harness-anything?style=flat&logo=github&color=yellow"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-brightgreen">
  <a href="./LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20%26%20unstable-orange">
</p>

<p>
  <a href="./README.md"><img alt="English README" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
</p>

</div>

---

Agent 擅长把东西做出来，却不擅长为自己说过的话负责。它会忘记上下文，会重议已经定下
的决定，也会在记录还没证明任何事情发生之前宣布胜利。

Harness Anything 给 agent 一份没法糊弄过去的台账。工作内容是纯 Markdown，审计轨迹是
git，出口是门禁：没有证据、没有真实 review、没有 CI 结果，就没有“done”。

## 快速开始

Harness Anything 目前从源码 checkout 运行，需要 Node.js 24+，公开命令表面仍在稳定中。
准确的安装与第一条循环命令维护在
[上手指南](./docs-release/start/zh/00-what-is-this.md)，那里是唯一的上手路径。

跑通第一条循环后，你的项目会拥有一个私有的嵌套 harness 台账。代码变更仍留在项目仓库；
harness 记录提交在台账自己的仓库里，避免任务证据混入普通代码提交。

## 你会得到什么

### 三原语台账

- **Decision（决定）**记录选择：问题、选中的路径、被拒的备选项、理由与裁决者。
  决定可以被 supersede，但不会被抹掉。
- **Task（任务）**记录工作：一个带计划、进度、事实、review 与收尾的任务包。生命周期
  状态由内核校验，终态完成必须过门禁。
- **Fact（事实）**记录证据：只追加的观察，带来源与置信度。后来的事实可以让早先的事实
  失效，但不会改写历史。

### 任务树，而不是一张平铺 todo

任务可以在创建时绑定父任务，可以渲染成树，也可以写入 task-to-task 的 `depends-on`
关系。父子绑定会做环检测，`depends-on` 写入会拒绝依赖环。父任务不会自动证明子任务已
关闭；完成门禁会把未关闭子任务作为告警报告，而不是假装整棵树已经完工。

证据：父任务解析在 `packages/cli/src/cli/parsers/new-task.ts`，任务树渲染在
`packages/cli/src/commands/core/task-query.ts`，父子环检测在
`packages/adapters/local/src/task-index.ts`，父任务不可变合同在
`packages/kernel/src/entity/field-contracts.ts`，依赖环拒绝在
`packages/cli/src/commands/core/task-relations.ts`。

### 一个服务多个台账的本地 daemon

Daemon 是本地写协调器。它可以注册多个已初始化的 harness 仓库，由一个用户级 daemon
服务它们，按 repo id 路由 CLI 请求，并在运行中挂上新注册的仓库。CLI 的 direct 模式仍然
存在；daemon-backed CLI 是显式 opt-in。

Daemon 不是 HTTP 服务，不是网络 API，也不是远程团队协作产品。只有仓库存在
`harness/people.yaml` 时才会执行授权；否则本地 daemon 连接信任本地传输边界。

证据：daemon start 在 `packages/cli/src/commands/daemon/productization.ts`，repo
registry 在 `packages/kernel/src/daemon/registry.ts`，多仓 serve 与 reconcile 在
`packages/cli/src/index.ts`，repo namespace 校验在
`packages/daemon/src/protocol/json-rpc-server.ts`。

### 读取真实台账的只读桌面面板

Electron 工作区可以通过本地 daemon bridge 读取真实的任务、文档、决定、事实与关系数据。
看板、筛选、收藏、关系图、事实 triage 与 copy-context 是围绕这些数据的检查工具。

它不是已发布的桌面 app。没有签名安装器、notarized 构建、release feed 或自动更新。不要
依赖 GUI 管理任务生命周期、写任务状态或裁决决定；写 handler 在 bridge 边界已经接好，
但当前视图仍以读取为主，部分表面仍是 mock-backed。

证据：renderer 读取在 `packages/gui/src/renderer/task-data.ts`，daemon bridge route 在
`packages/gui/src/api/service-bridge.ts`，client call 在
`packages/gui/src/renderer/api-client.ts`，只读 decision 接线在
`packages/gui/src/renderer/App.tsx`，运行时自声明在
`packages/gui/src/distribution/runtime-release-readiness.ts`，未签名 builder 配置在
`packages/gui/electron-builder.config.mjs`。

### 被硬化的写路径

承重写入现在要求显式 actor 归属。Decision snapshot 使用乐观并发检查；逐字节相同的重复
fact append 是幂等 no-op；大型 session body 可以作为内容寻址 blob 存在 harness 台账下。

证据：actor 归属在 `packages/cli/src/composition/actor-attribution.ts`，decision CAS 在
`packages/kernel/src/store/write-journal-decision-documents.ts`，幂等 fact append 在
`packages/kernel/src/store/write-journal-operations.ts`，blob store 在
`packages/kernel/src/store/content-addressed-blob-store.ts`。

## 文档

三条轨道，由浅入深：

- [上手（Start）](./docs-release/start/zh/00-what-is-this.md)：安装、跑通一条真实循环、日常命令。（[English](./docs-release/start/en/00-what-is-this.md)）
- [理解（Learn）](./docs-release/learn/zh/00-overview.md)：三原语内核、门禁与 fail-closed、采用定律。（[English](./docs-release/learn/en/00-overview.md)）
- [架构（Architecture）](./docs-release/architecture/zh/00-overview.md)：存储模型、写入路径、投影、流水线里的门禁。（[English](./docs-release/architecture/en/00-overview.md)）

另见：[发布态势](./docs-release/release-posture.md)，它是当前产品与发布状态的唯一公开来源；
以及 [最小示例项目](./examples/minimal-project/)。

## 深入了解

<details>
<summary><b>架构</b>：一个小内核，其余一切都消费它</summary>

<br>

内核（kernel）是唯一语义权威。它拥有领域模型：三原语、任务身份、生命周期词表、schema、
投影、关系与存储端口。生命周期转换只在一处校验；边缘层消费这些语义，而不是重新定义。

内核之外的一切都是消费方。CLI 解析命令并渲染回执，application 层把编排隔离在 UI 与
adapter 代码之外，daemon 串行化本地写入，adapter 在边界收集或投影证据。Authored 状态是
git 下的 Markdown；generated 状态是可重建缓存。

| 层 | 作用 |
| --- | --- |
| **Kernel（内核）** | 原语、领域类型、生命周期、schema、关系投影、存储端口。 |
| **CLI** | init、doctor、status、check、任务、决定、事实、preset、module、迁移、证据与 daemon 路由等本地命令表面。 |
| **Application** | CLI 与 GUI 共享的 controller/service 编排层。 |
| **Daemon** | 本地多仓协调、串行化写入、命令事件、repo 路由。 |
| **GUI** | 基于真实台账读取的 Electron 检查面板与 daemon bridge；不是完整写产品。 |
| **Adapters** | 外部系统边界，不接管 harness 真相。 |

</details>

<details>
<summary><b>核心概念</b>：原语、证据、门禁、生命周期</summary>

<br>

- **Gate（门禁）**：对承重写入的 fail-closed 检查：要求事实，review 结论经 schema
  校验，收尾占位被拒，CI 结果被强制，完成时检查 code-doc anchors。
- **Vertical 与 preset**：vertical（如 `software/coding`）定义任务领域与合同；preset
  在其上添加工作流模板、检查与动作。
- **Module（模块）**：项目里注册过的切片，任务可以指向它，让多模块工作保持可过滤、
  可限定范围。
- **Projection（投影）**：从 Markdown 派生的 SQLite 读模型。陈旧或缺失时可以重建；文件
  仍是真相来源。

</details>

<details>
<summary><b>包结构</b>：monorepo 布局</summary>

<br>

单一 git monorepo。`packages/` 下的包是 npm workspace package。目前没有任何包从这个仓库
发布到 npm。

| Package | 用途 |
| --- | --- |
| `@harness-anything/kernel` | 领域模型、原语、生命周期、schema、投影、存储端口。 |
| `@harness-anything/cli` | 面向 project、task、decision、fact、preset、module、migration、evidence、daemon 与 check 的本地命令表面。 |
| `@harness-anything/application` | CLI 与 GUI 共享的 controller/service 层。 |
| `@harness-anything/daemon` | 本地 JSON-RPC daemon runtime、repo namespace 路由、传输与身份边界。 |
| `@harness-anything/gui` | Electron GUI foundation、daemon/API 契约、renderer 边界。 |
| `@harness-anything/adapter-local` | 本地 adapter 表面。 |
| `@harness-anything/adapter-multica` | Multica issue 快照/采纳表面。 |
| `@harness-anything/adapter-github-issues` | 未来 GitHub Issues 集成的占位包。 |
| `@harness-anything/adapter-linear` | 未来 Linear 集成的占位包。 |

</details>

<details>
<summary><b>发布态势</b>：状态指针</summary>

<br>

[Shipped / Foundation / Planned 状态](./docs-release/release-posture.md) 只存在于发布态势页；
那里是 runtime、打包、能力、供应链与 license 状态的唯一公开来源。本 README 刻意不复制
那张状态矩阵。

</details>

<details>
<summary><b>设计原则</b>：检查在强制的规则</summary>

<br>

- **唯一的路是有门禁的路。** agent 会采用任何存在的路径；留一条没门禁的捷径，它就会走。
- **语义只住在内核里。** 边缘层消费领域模型，从不重新定义生命周期、身份或校验。
- **契约从单一权威源派生。** 命令回执、API registry 和 schema 对齐单一权威；表面漂移会让
  治理检查失败。
- **Authored 状态是真相，generated 状态是缓存。** git 下的 Markdown 是规范来源；SQLite
  投影可重建、可验证。
- **休眠代码不发布。** 占位就明确标注为占位；发布门禁要求证据先于发布。

</details>

## 贡献

当前最有价值的贡献是尖锐的 bug report、可复现的失败测试、架构问题和小型文档修正。提交
pull request 前，请运行贡献指南中记录的本地 gate。

请不要把 private harness state 放进公开变更：不要提交 `.harness-private/`、root-local
agent instructions 或 private planning docs。参见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

[AGPL-3.0-or-later](./LICENSE)。Harness Anything 保持开源，包括有人把它作为服务提供时。
