<div align="center">

# Harness Anything

**你的 agent 说做完了。让它拿出证据。**

Harness Anything 是 AI agent 的问责层（accountability layer）：agent 产出的每一个
决定、任务、事实，都变成 git 里可审计的结构——而"做完了"必须带着证据过门禁。

<p>
  <a href="#快速开始">快速开始</a> ·
  <a href="#常用配方">常用配方</a> ·
  <a href="#文档">文档</a> ·
  <a href="#深入了解">深入了解</a>
</p>

<p>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/FairladyZ625/harness-anything?style=flat&logo=github&color=yellow"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-brightgreen">
  <a href="./LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20%26%20unstable-orange">
</p>

<p>
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
</p>

</div>

---

```console
$ ha task create --title "Add rate limiting to /api/upload"
ok  task_01KWVVJC94 · planned

# ── agent 埋头苦干一阵，然后宣布胜利 ──

$ ha task transition task_01KWVVJC94 done
error  code=terminal_status_requires_task_complete
       "done" 要靠完成门挣来，不是靠嘴宣布。

$ ha task complete task_01KWVVJC94 --ci passed
error  code=task_fact_required
       完成需要至少一条已记录的 fact。拿证据来。

$ ha fact record --task task_01KWVVJC94 \
    --statement "429 returned after 100 req/min; regression suite green" \
    --source "npm test -- rate-limit.spec.ts" --confidence high
ok  fact recorded to the task ledger

$ ha task complete task_01KWVVJC94 --ci passed --reviewer alex
error  code=review_placeholder
       模板不算 review。写下真实结论。

# ── 一份真实的 review 结论之后 ──

$ ha task complete task_01KWVVJC94 --ci passed --reviewer alex
ok  task_01KWVVJC94 · done — 证据封印，全程在案，落在 git 里
```

上面每一个 `error` 都是真实输出。agent 拿不出证据之前，没有资格说"done"。

## 为什么需要它

每个用过 agent 的人都经历过那个瞬间。*"所有测试通过——功能完成！"*——测试根本
没跑过。三个会话之前谈好的方案，已经悄悄变了样。上个月那次架构调整背后的理由，
埋在一段没人会再翻的聊天记录里。

Agent 极其擅长*把活干出来*，又极其不擅长为干出来的活*负责*。它们会忘——context
被压缩，会话会结束。它们会漂——定好的决定被悄悄推翻重议。它们还会宣布胜利——
因为凡事都自己复核一遍，根本扩展不起来。

换更好的 prompt 是治不好这个的。你无法阻止 agent 在干活的当下偷工减料——就像你
无法阻止一个人。对人类一直有效的办法，对 agent 同样有效：**摄像头，加追责。**把
每一句声称都写进永久记录，把出口都设上门禁，让虚假的"做完了"再也站不住。

这些门禁不是在白板上设计出来的。Harness Anything 管理着它自己的开发；这期间我们
亲眼看着自己的 agent 走上每一条没有门禁的"完成"捷径——**100% 的概率**。agent 只
走存在的那条路。所以我们把证据做成了唯一的路。

## 工作原理

agent 产出的一切，都落成**三种原语（primitive）**之一，以纯 markdown 写进你的
仓库：

- **Decision（决定）** — 回答*为什么*。一个带备选项、理由和具名裁决者的选择。
  决定可以被推翻，但永不抹除。
- **Task（任务）** — 回答*做什么*。一套六状态生命周期，只在唯一一处校验，
  `done` 被锁在完成门禁之后。
- **Fact（事实）** — 就是*证据*。带来源、只追加的观察记录。事实可以被更新的
  事实作废，但永不就地编辑。

三条性质让这份记录值得信任：

- **它就是 git。** 整份台账都是版本控制下的纯 markdown——能 grep、能 diff、能在
  PR 里 review。没有数据库要伺候，也没有 lock-in。一份 SQLite 投影负责快速查询，
  随时可以删掉、再从 markdown 重建；文件才是事实。
- **门禁失败即关闭（fail closed）。** `done` 需要已记录的事实、一份经 schema 校验
  的 review 结论、一次真实的收尾、以及一个 CI 结果。占位文本会被拒。不存在任何
  绕开门禁的路径。
- **没有一句话是场外的。** 进度、review、决定和证据都沉淀在任务包里。下个月某处
  出岔子时，你回放这份记录，而不是去审问一个早已消失的聊天会话。

而它只是一个 CLI。任何能跑 shell 的东西都可以被套上缰绳——Claude Code、Codex、
你自研的 agent，或者你旁边的同事。decision / task / fact 没有任何一处是只属于写
代码的：你交给 agent 的任何长程工作，它都能治理。所以才叫 Harness **Anything**。

## 快速开始

> **还没上 npm。** 在 CLI 表面稳定之前，Harness Anything 从源码 checkout 全局安装。
> 需要 **Node.js 24+** 和 git。

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run build -w @harness-anything/cli
npm install -g ./packages/cli    # 安装 `ha` 命令
ha doctor           # 只读的环境体检
```

然后在任意 git 项目里跑第一条循环：

```bash
cd /path/to/your/project
ha init                                            # 生成 ./harness 目录结构
ha task create --title "First task"                # 返回一个 task_<id>
ha task transition <task-id> active
ha fact record --task <task-id> \
  --statement "what was verified" --source "the command or path that proves it"
ha status
```

诀窍全在这里：任务、证据，以及其间的每一句声称，现在都是仓库里带版本的文件——
能在 diff 里 review，下个会话、下个月、下个 agent 接手时都还在。

## 常用配方

```bash
# 把一个选择记录在案——备选项、理由、裁决者
ha decision propose --title "Rate limiter algorithm" \
    --question "Sliding window or token bucket?" \
    --chosen "Sliding window" --rejected "Token bucket" \
    --why-not "Burst tolerance not needed at this tier"
ha decision accept dec_01ABC --arbiter human:you

# 边干活边记录证据
ha fact record --task task_01ABC --statement "p95 latency 84ms after cache" \
    --source "npm run bench" --confidence high

# 走 review + CI + 证据门禁关闭任务
ha task transition task_01ABC in_review
ha task review task_01ABC --reviewer alex
ha task complete task_01ABC --ci passed --reviewer alex

# 审问这份记录
ha task list --state in_review
ha task show task_01ABC
ha decision list --search "rate limit"
ha relation list --entity task/task_01ABC
ha fact list --task task_01ABC

# 证明本地状态仍与仓库一致
ha check
```

CLI（`harness-anything`，别名 `ha`）在任务、决定、事实、证据、迁移接入和一整套
扩展表面之上，暴露 50+ 个命令。日常命令参考见
[上手指南](./docs-release/start/zh/03-daily-commands.md)，工具本身永远是最新的：
`ha --help` 和 `ha capabilities`。

## 文档

三条轨道，由浅入深：

- [上手（Start）](./docs-release/start/zh/00-what-is-this.md) — 安装、跑通一条真实循环、日常命令。约 10 分钟。（[English](./docs-release/start/en/00-what-is-this.md)）
- [理解（Learn）](./docs-release/learn/zh/00-overview.md) — 那些理念：三原语内核、门禁与 fail-closed、采用定律。（[English](./docs-release/learn/en/00-overview.md)）
- [架构（Architecture）](./docs-release/architecture/zh/00-overview.md) — 机器本身：存储模型、写入路径、投影、流水线里的门禁。（[English](./docs-release/architecture/en/00-overview.md)）

此外：[发布态势](./docs-release/release-posture.md) — 什么已交付、什么只是
foundation、什么仍在规划——以及一个
[最小示例项目](./examples/minimal-project/)。

## 深入了解

<details>
<summary><b>架构</b> — 一个小内核，其余一切都消费它</summary>

<br>

内核（kernel）是唯一的语义权威。它拥有领域模型——三原语、任务身份、六态生命周期、
schema，以及其余一切消费的存储端口。生命周期转换只在唯一一处校验；没有任何边缘层
有资格重新定义"done"是什么意思。

内核之外的一切都是消费方。CLI 解析命令并渲染回执，GUI foundation 映射 daemon 与
API 契约，application 层把编排隔离在 UI 代码之外，adapter 在边界上收集或发布证据。
契约——命令回执、API 注册表、schema——从单一权威源派生，而不是每个表面各自重新
声明一份。

Authored 状态是 git 下的纯 markdown；generated 状态是可重建的缓存。markdown 是事实，
SQLite 投影从它派生，`ha check` 随时能证明两者是否一致。

| 层 | 作用 |
| --- | --- |
| **Kernel（内核）** | 三原语、领域类型、六态生命周期、schema、投影、存储端口。 |
| **CLI** | init、doctor、status、check、任务、决定、事实、preset、module、迁移与证据等本地命令。 |
| **Application** | 把 controller/service 编排从 UI 和 adapter 代码中隔离出来。 |
| **GUI foundation** | Electron 壳、daemon/API 契约、会话策略、分发/更新边界。是 foundation，不是成品。 |
| **Adapters** | 连接外部系统，但不接管 harness 状态。 |

</details>

<details>
<summary><b>核心概念</b> — 原语、证据、门禁、生命周期</summary>

<br>

- **Decision（决定）** — 一个可被推翻的选择：问题、选中的路径、被拒的备选项、
  为何不选，以及一位具名裁决者。通过带类型、载有理由的关系与任务和事实相连。
  只会被 supersede，永不删除。
- **Task（任务）** — 位于 `harness/tasks/` 下的一个 markdown 包，身份是随机的
  `task_<ULID>`，装着一个工作单元的计划、进度、事实、review 和收尾。六个状态：
  `planned`、`active`、`blocked`、`in_review`、`done`、`cancelled`。终态只能经完成
  门禁抵达；后续工作走 supersede，不走 reopen。
- **Fact（事实）** — 一条只追加的观察，带陈述、来源和置信度。review 和完成都需要
  真实的事实；事实被更新的事实作废，永不就地编辑。
- **Gate（门禁）** — 对承重写入的 fail-closed 检查：要求事实、review 结论经 schema
  校验、收尾占位被拒、CI 结果被强制。错误是类型化的（`task_fact_required`、
  `review_placeholder` …），让 agent 拿到机器可读的指示，走上合法那条路。
- **Vertical 与 preset** — vertical（如 `software/coding`）定义任务领域和它的契约；
  preset 在其上叠加工作流选择——模板、检查、动作。
- **Module（模块）** — 项目里一块注册过的切片，任务可以指向它，让多模块工作保持
  可过滤、可限定范围。

</details>

<details>
<summary><b>包结构</b> — monorepo 布局</summary>

<br>

单一 git monorepo。`packages/` 下的包是 npm workspace package（不是嵌套仓库），
全部 `private: true`——目前没有任何包发布到 npm。

| Package | 用途 |
| --- | --- |
| `@harness-anything/kernel` | 领域模型、三原语、生命周期、schema、投影、存储端口。 |
| `@harness-anything/cli` | 面向 project、task、decision、fact、preset、module、migration、evidence 和 check 的本地命令表面。 |
| `@harness-anything/application` | CLI 和 GUI 共享的 controller/service 层。 |
| `@harness-anything/gui` | Electron GUI foundation、daemon/API 契约、renderer 边界。 |
| `@harness-anything/adapter-local` | 本地 adapter 表面。 |
| `@harness-anything/adapter-multica` | Multica issue 快照/采纳表面。 |
| `@harness-anything/adapter-github-issues` | GitHub Issues 占位包。 |
| `@harness-anything/adapter-linear` | Linear 占位包。 |

</details>

<details>
<summary><b>发布边界</b> — 今天什么是真的</summary>

<br>

发布治理唯一的公开锚点是
[发布态势](./docs-release/release-posture.md)：什么已交付、什么只是 foundation、
什么仍在规划，以及未来任何发布都必须通过的供应链与 license 门禁。

一句话版本：内核、CLI 和治理检查都是真的、每天在用——这个仓库就跑在它自己的
harness 之下。不声称任何 npm 包发布——所有包都保持 `private: true`，且发布前必须
先交出 OSV、license、SBOM 证据。M2.5 GUI/daemon foundation 交付的只是契约与策略；
不声称有签名桌面安装器、notarized 构建或自动更新能力。

**运行时与门禁：** 使用 Node.js 24 或更新版本。源码冒烟是
`node packages/cli/src/index.ts --json doctor`；完整本地门禁是 `npm run check`。
公开 CI 覆盖 Node 24 与 Node 26，包冒烟走 `npm run harness:smoke-cli-package`。
OSV 就绪度与 AGPL 网络服务发布说明清单由供应链门禁跟踪。

公开表面稳定前，请预期 breaking changes。

</details>

<details>
<summary><b>设计原则</b> — 检查在强制的规则</summary>

<br>

- **唯一的路是有门禁的路。** agent 会采用任何存在的路径；留一条没门禁的捷径，它
  就一定会走。所以承重写入都要经校验，而校验 fail closed。
- **语义只住在内核里。** 边缘层消费领域模型，从不重新定义生命周期、身份或校验。
- **契约从单一权威源派生。** 命令回执、API 注册表和 schema 只对齐一个权威源；任何
  表面漂移都会让治理检查失败。
- **Authored 状态是真相，generated 状态是缓存。** git 下的 markdown 是规范来源；
  SQLite 投影可重建，其完整性可验证。
- **休眠代码不发布。** 占位就明确标注为占位；发布门禁要求证据——OSV、license、
  SBOM——任何东西发布之前都要过这一关。

</details>

## 贡献

当前最有价值的贡献是尖锐的 bug report、可复现的失败测试、架构问题和小型文档修正。
提交 pull request 前，先跑完整的本地 gate：

```bash
npm run check
```

请不要把 private harness state 放进公开变更——不要把 `.harness-private/`、
root-local agent instructions 或 private planning docs 加入 public commit。参见
[CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

[AGPL-3.0-or-later](./LICENSE)。Harness Anything 保持开源——包括有人把它作为服务
提供时。
