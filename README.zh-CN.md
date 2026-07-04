<div align="center">

# Harness Anything

**为 coding agent 而生的持久任务层。**

本地 markdown 任务包、一套 agent 糊弄不了的生命周期、以及真正能被检测出来的
状态漂移——让长周期工作扛得住会话边界。

<p>
  <a href="#快速开始">快速开始</a> ·
  <a href="#常用命令">常用命令</a> ·
  <a href="#文档">文档</a> ·
  <a href="#深入了解">深入了解</a>
</p>

<p>
  <a href="./LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/FairladyZ625/harness-anything?style=flat&logo=github&color=yellow"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-brightgreen">
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20%26%20unstable-orange">
</p>

<p>
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
</p>

</div>

---

```console
$ ha init
✓ harness ready  ·  任务以纯 markdown 存放在 ./harness/planning/tasks/

$ ha new-task --title "给 /api/upload 加限流" \
      --vertical software/coding --preset standard-task
✓ task_01JQ8F3K2M  ·  planned

$ ha status
  task_01JQ8F3K2M   planned     给 /api/upload 加限流
  task_01JQ2A9X7P   in_review   重构上传的 MIME 嗅探
  task_01JP7Z0C4B   blocked     迁移 legacy 任务队列

# …agent 写完代码、开了 PR、CI 也绿了…

$ ha task-complete task_01JQ8F3K2M --ci passed --reviewer alex
✓ done  ·  review 与 CI 证据已封存到任务里

$ ha check --post-merge
✓ 生命周期合法    ✓ 证据完整    ✓ 本地状态与仓库一致
```

## 为什么需要它

一小时前你的 agent 还把任务做得漂漂亮亮。现在会话被压缩了，计划在三屏之外的
聊天记录里，*"我刚才在干嘛来着？"* 这个问题竟然真的不好回答。

- 凭什么 agent 的任务状态得住在聊天记录里？
- 凭什么想知道 *"这事到底做完没"* 还得把对话从头翻一遍？
- 凭什么拆分、恢复、**证明**一段工作，要比动一个文件更麻烦？

Coding agent 很会写代码，却不擅长记住自己在做什么，更不擅长证明做过什么。
Harness Anything 补上后半截：任务包持久落盘、生命周期糊弄不过去、一条命令就能
告诉你本地状态还跟仓库对不对得上。

*Harness Anything 自己的开发就跑在它上面——这个 harness 的第一个用户就是它自己。*

## 亮点

- **Local-first，markdown 原生。** 任务就是 Git 里的文件——能 grep、能 diff、
  能在 PR 里 review。没有数据库要伺候，也没有 lock-in。
- **一套 agent 糊弄不了的生命周期。** 六个状态，只在一个地方校验转换。"done"
  意味着 review 过、CI 过、证据齐了，而不是"agent 说做完了"。
- **漂移可检测。** 每个任务都带类型化证据，一条命令就能证明本地状态没有悄悄
  偏离仓库。
- **为被扩展而设计。** 一个小 kernel（内核）掌管规则；CLI、GUI、adapter 在其上
  组合，永远不重新定义规则。

## 快速开始

> **还没上 npm。** 在 CLI 表面稳定之前，Harness Anything 从源码运行。需要
> **Node.js 24+**。

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run check   # typecheck、测试、治理与供应链门槛
```

CLI 直接从源码运行（依赖 Node 内建的 TypeScript 执行）。本文示例为了好读都用
`ha`，先设一次别名：

```bash
alias ha="node $(pwd)/packages/cli/src/index.ts"
ha doctor --json    # 先体检一下环境
```

然后在任意项目里跑最小循环：

```bash
ha --root /path/to/project init             # 生成 ./harness 目录结构
ha --root /path/to/project new-task --title "第一个任务"
ha --root /path/to/project status
ha --root /path/to/project check --post-merge
```

到这一步，你就有了持久、可检查的任务状态——任何 agent（或人）都能冷启动接手。

## 常用命令

```bash
# 在 coding vertical 里用预设工作流开一个任务
ha new-task --title "实现某个切片" --vertical software/coding --preset standard-task

# 转换任务状态，记录在案
ha task status set task_01JQ8F3K2M active --reason "开始做了"

# 走 review + CI 门槛关闭任务
ha task-complete task_01JQ8F3K2M --ci passed --reviewer alex

# 针对某个 base ref 抓一份 Git diff 作为证据
ha git-diff --base origin/main --json

# 把没做完的旧任务带着 provenance 重建成新任务
ha new-task --from-legacy <legacy-id>

# 证明本地状态仍与仓库一致
ha check --post-merge --json
```

CLI 命令是 `harness-anything`，短别名 `ha`，覆盖项目初始化、任务创建、生命
周期、review/CI 门槛、迁移接入、证据和扩展表面等 50+ 个命令。日常命令参考见
[上手指南](./docs-release/start/zh/03-daily-commands.md)。

## 文档

- [上手指南](./docs-release/start/zh/00-what-is-this.md) — 安装、第一条循环与日常命令（[English](./docs-release/start/en/00-what-is-this.md)）
- [深入指南](./docs-release/learn/zh/00-overview.md) — 内核、决策、门槛、vertical 与路线图（[English](./docs-release/learn/en/00-overview.md)）
- [发布态势](./docs-release/release-posture.md) — 运行时/发布、供应链与 license、产品线状态
- [最小示例项目](./examples/minimal-project/)

## 深入了解

<details>
<summary><b>架构</b> — 一个小 kernel，其余一切都消费它</summary>

<br>

Kernel 是唯一的语义权威。它拥有领域模型——任务身份、六态 lifecycle、外部
binding（绑定）、包处置、closeout readiness——以及所有其他部分消费的 schema 和
存储端口。生命周期转换只在一个地方校验；任何边缘层都不能重新定义什么叫 "done"。

Kernel 之外的一切都是消费方。CLI 解析命令并渲染回执，GUI foundation 映射
daemon/API 契约，application 层把编排隔离在 UI 代码之外，adapter 在边界上收集或
发布证据。契约——命令回执、API 注册表、schema——从单一权威源派生，而不是每个
表面各自声明一份。

Authored 状态是 Git 里的纯 markdown；generated 状态是可重建的缓存。markdown 任务
包是事实来源，SQLite 投影从它派生，检查随时能证明两者是否一致。

| 层 | 作用 |
| --- | --- |
| **Kernel** | 领域类型、六态 lifecycle、schema、任务投影、生命周期校验、存储端口。 |
| **CLI** | init、doctor、status、check、任务、preset、module、迁移与 Git diff 证据等本地命令。 |
| **Application** | 把 controller/service 编排从 UI 和 adapter 代码中隔离出来。 |
| **GUI foundation** | Electron 壳、daemon/API 契约、会话策略、分发/更新边界。是 foundation，不是成品。 |
| **Adapters** | 连接外部系统，但不接管 harness 状态。 |

</details>

<details>
<summary><b>核心概念</b> — 任务包、证据、绑定、生命周期</summary>

<br>

- **Task package（任务包）** — 位于 `harness/planning/tasks/` 下的 markdown 包，
  身份是随机的 `task_<ULID>`。它是一个工作单元的事实来源；slug 和标题只是展示
  元数据，不是身份。
- **Evidence（证据）** — 附加在进度、review 和完成记录上的类型化指针
  （`type:path:summary`），另有面向 Git diff 和 legacy 迁移的专用证据。证据靠
  记录，不靠推断。
- **Binding（绑定）** — 任务与外部引擎引用之间一条带指纹的链接。核心字段创建后
  不可变，因此篡改可被检测。
- **Lifecycle（生命周期）** — 六个状态：`planned`、`active`、`blocked`、
  `in_review`、`done`、`cancelled`。`done` 和 `cancelled` 是终态；后续工作走
  supersede，不走 reopen。归档和 tombstone 是包处置，不是额外状态。
- **Vertical 与 preset** — vertical（如 `software/coding`）定义任务领域和它的
  契约；preset（如 `standard-task`）在其上叠加工作流选择——模板、检查、动作。
- **Module（模块）** — 项目里一块注册过的切片，任务可以指向它，让多模块工作
  保持可过滤、可限定范围。

</details>

<details>
<summary><b>包结构</b> — monorepo 布局</summary>

<br>

单一 Git monorepo。`packages/` 下的包是 npm workspace package（不是嵌套仓库），
全部 `private: true`、版本 `0.0.0`——目前没有任何包发布到 npm。

| Package | 用途 |
| --- | --- |
| `@harness-anything/kernel` | 领域模型、六态 lifecycle、schema、任务投影、存储端口。 |
| `@harness-anything/cli` | 面向 project、task、preset、module、migration、evidence 和 check 的本地命令表面。 |
| `@harness-anything/application` | CLI 和 GUI 共享的 controller/service 层。 |
| `@harness-anything/gui` | Electron GUI foundation、daemon/API 契约、renderer 边界。 |
| `@harness-anything/adapter-local` | 本地 adapter 表面。 |
| `@harness-anything/adapter-multica` | Multica issue 快照/采纳表面。 |
| `@harness-anything/adapter-github-issues` | GitHub Issues 集成的 M4 占位包。 |
| `@harness-anything/adapter-linear` | Linear 集成的 M4 占位包。 |

</details>

<details>
<summary><b>发布边界与 Roadmap</b> — 今天什么是真的</summary>

<br>

**已交付：** kernel、CLI、application 层、治理检查、Legacy Intake readiness
（M2）；GUI/daemon foundation、运行时/发布可复现性、供应链/license 发布门槛
（M2.5）。

**是 foundation，不是成品：** GUI daemon 契约已存在且被检查覆盖，但还没有完整的
桌面 GUI、签名安装器、公证构建或自动更新。

**尚未交付：** 没有 npm 发布（包保持 `private: true`、`0.0.0`；未来任何发布都
必须附带 OSV、license、SBOM 证据）；GitHub Issues 和 Linear adapter 仍是 M4 占位。

**M2.5 GUI/daemon foundation：** GUI workspace、daemon/API、terminal、remote
tunnel 与分发策略已有公开契约，但发布产物仍未交付。No npm package release is claimed.

**运行时与发布门槛：** Use Node.js 24 or newer。source-run smoke 是
`node packages/cli/src/index.ts --json doctor`；完整本地门槛是 `npm run check`。
公开 CI 覆盖 Node 24 and Node 26，package smoke 通过
`npm run harness:smoke-cli-package` 执行。No signed desktop installer,
notarized build, or auto-update capability is
  claimed。OSV readiness 与 AGPL network-service release-note checklist 由供应链
门槛跟踪。

**Roadmap：** M2 ✓ · M2.5 ✓ · **M3** 任务层级与关系语义 · **M4** 外部 adapter
实现 · **M5–M7** 跨 harness 产品线、完整 GUI 产品、npm 发布、发布硬化。

公开表面稳定前，请预期 breaking changes。

</details>

<details>
<summary><b>设计原则</b> — 检查在强制的规则</summary>

<br>

- **语义只住在 kernel 里。** 边缘层消费领域模型，从不重新定义 lifecycle、身份
  或校验规则。
- **契约从单一权威源派生。** 命令回执、API 注册表和 schema 只对齐一个权威源；
  任何表面漂移都会被治理检查拦下。
- **Authored 状态是真相，generated 状态是缓存。** Git 里的 markdown 任务包是
  规范来源；SQLite 投影可重建，其完整性可验证。
- **休眠代码不发布。** 占位表面明确标注为占位；发布门槛要求证据——OSV、
  license、SBOM——任何东西发布之前都要过这一关。

</details>

## 贡献

当前最有价值的贡献是尖锐的 bug report、可复现的失败测试、架构问题和小型文档
修正。提交 pull request 前，先跑完整的本地 gate：

```bash
npm run check
```

请不要把 private harness state 放进公开变更——不要把 `.harness-private/`、
root-local agent instructions 或 private planning docs 加入 public commit。参见
[CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

[AGPL-3.0-or-later](./LICENSE)。Harness Anything 保持开源——包括有人把它作为
服务提供时。
