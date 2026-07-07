# GUI-V1 · 状态清单 (Status Checklist)

- **状态**: working-ledger
- **日期**: 2026-06-14（**2026-07-02 修订**：按三元语改版对齐 00/01 新 Phase 0–5 结构重排条目；里程碑启动（M2.5-GUI 入口条件满足）；GUI-V1 主协调任务 module `gui-v1` 注册，packet 账本挂其下。实现类条目均未开工，本次修订不改变任何 not_started 状态；**2026-07-07 daemon pivot re-charter（dec_mr9z0b7m）**：Phase 1 由「自建 Daemon Runtime」改为「消费 PLT-Daemon」，状态词随之更新；波 2 派发 RC-A/B/C 三包（re-charter 文档 / 三元语原型 / task 外壳）；daemon 本身 W1/W2/W3/W4/W6 已合入 main）
- **日期注**: 2026-07-07 re-chartered per dec_mr9z0b7m: 自建 daemon 剥离归 PLT-Daemon, GUI-V1 消费不自建。
- **来源**: 00-overview.md、01-feature-breakdown.md、`40-gui-and-apps/41-triadic-gui-information-architecture.md`（canonical IA 目标；31/31B 部分过时）
- **入口条件**: M2.5-GUI + PLT-Daemon（re-charter 后；本地集成待 daemon W5 #245 合并、远程依赖 W7）

## 状态词说明

本清单使用局部状态词记录进度，不等同于 public shipped claim：

- `not_started`: 尚未开始；无代码、无 ADR、无 spike。
- `in_progress`: 正在实施；有 WIP 代码或 draft ADR。
- `blocked`: 被前置条件阻塞；阻塞来源已标注。
- `done`: 该功能组在本里程碑要求的口径内完成；有 exit evidence。

## 里程碑状态

| 项 | 状态 | 证据/说明 |
| --- | --- | --- |
| GUI-V1 入口 | done | M2.5-GUI 已收口（`../../foundation/m2-5-gui/03-review-action-matrix.md` review-ledger-closed）；2026-07-02 里程碑启动 |
| 主协调任务 | done | module `gui-v1` 已注册；packet 账本落于该 module |
| 功能拆解 | done | `01-feature-breakdown.md` 已按三元语改版定义 Phase 0–5 功能组（2026-07-02） |
| task packets | wave-1-dispatched | 2026-07-02 波 1 已派发 5 包：GUI-P00 原型收件箱（task_01KWGEEDKKYYH73J4T3VM0BHTV）+ 4 个 PRE（task_01KWGEEEFS13Z4HNVHZSYZ9Z3E / …FBQNT… / …G8DB… / …H53P…）；账本见主协调任务 task_01KWGEE4WVM6C702RQP9TX9A9C |
| Phase 0 前置条件 | dispatched | 4 项 PRE 已随波 1 派发（GUI-P01..P04），实现未开始 |
| Phase 1 Daemon 消费接入（consume PLT-Daemon，不自建） | not_started | daemon 服务端归 PLT-Daemon（W1/W2/W3/W4/W6 已合入 main；本地 serve loop 待 W5 #245、远程待 W7）；GUI 侧客户端消费层未开工 |
| Phase 2 Electron Shell + Task 操作面 | in_progress | RC-C（task_01KWX36ASX1SE2YV2YP0QC1KRE）加固 task 外壳对冻结契约绑定，进行中（worktree codex/gui-v1-rc-c-task-shell） |
| Phase 3 三元语视图 | blocked | 入口 = M3 TP-M3-06 exit + TP-M3-12b 基准 + FG-P1-07（均未达成） |
| Phase 4 产品化与分发 | not_started | 无安装包、签名、自动更新 |
| Phase 5 SSH 远程 | not_started | 无 tunnel/remote 代码 |

## 功能组清单 — Phase 0: 技术选型与前置条件

| 勾选 | 功能组 | 状态 | Packet | 说明 |
| --- | --- | --- | --- | --- |
| [ ] | FG-P0-01 React 状态管理选型 | not_started | — | ADR 未创建 |
| [ ] | FG-P0-02 Electron E2E 测试选型 | not_started | — | ADR 未创建；范围受 ADR-0015/E57 约束（只裁 E2E driver） |
| [ ] | FG-P0-03 Application 层异步 I/O 迁移 | not_started | — | M2.5-GUI deferred blocker 未关闭 |
| [ ] | FG-P0-04 Accessibility Baseline | not_started | — | 基线声明未创建 |

## 功能组清单 — Phase 1: Daemon 消费接入（consume PLT-Daemon，不自建）

> 2026-07-07 re-charter（dec_mr9z0b7m）：下列 FG 全部为 GUI 侧**客户端消费**能力；消费 PLT-Daemon 提供的 JSON-RPC daemon，GUI 做协议客户端（hello handshake / transport client / RBAC-aware actor display），不做 daemon 服务端；daemon 服务端实现归 PLT-Daemon W1–W8。

| 勾选 | 功能组 | 状态 | Packet | 说明 |
| --- | --- | --- | --- | --- |
| [ ] | FG-P1-01 传输客户端连接（消费 W3） | not_started | — | GUI 侧未开工；服务端传输库 W3 已合（#239）；本地 serve loop 待 W5 #245 |
| [ ] | FG-P1-02 JSON-RPC 客户端层（消费 W2） | not_started | — | GUI 侧未开工；协议核心 W2 已合（#233） |
| [ ] | FG-P1-03 命令消费面 client（task 域） | not_started | — | GUI 侧未开工；`repo.*` 派生自 apiRouteContracts（task 面冻结） |
| [ ] | FG-P1-04 Terminal attach client | not_started | — | GUI 侧未开工；daemon PTY 服务端属 daemon 线 |
| [ ] | FG-P1-05 身份/RBAC 感知 client（消费 W4） | not_started | — | GUI 侧未开工；身份盖章 W4 已合（#243）；无 people.yaml 时 daemon 不盖章 |
| [ ] | FG-P1-06 连接生命周期 client（消费 W5） | not_started | — | GUI 侧未开工；thin-client 服务端 W5 待合（#245） |
| [ ] | FG-P1-07 Decision ops 消费 client | blocked | — | 依赖 M3 第一梯队（TP-M3-03b/04）exit + daemon 暴露该域；当前 decision/fact 客户端读写面不存在 |

## 功能组清单 — Phase 2: Electron Shell + Task 操作面

| 勾选 | 功能组 | 状态 | Packet | 说明 |
| --- | --- | --- | --- | --- |
| [ ] | FG-P2-01 Electron main process | not_started | — | 无生产级 main 进程 |
| [ ] | FG-P2-02 IPC bridge | not_started | — | 无 typed IPC bridge |
| [ ] | FG-P2-03 Workspace shell | not_started | — | 无工作区壳层 UI |
| [ ] | FG-P2-04 Task Board/List 视图 | not_started | — | 无生产级 task 视图（含 spawningDecision 徽章/派生入口组件位） |
| [ ] | FG-P2-05 Task Detail + Doc Viewer | not_started | — | 无 task 详情/文档渲染（含 F-id chip 组件位） |
| [ ] | FG-P2-06 Terminal view | not_started | — | 无终端视图 |
| [ ] | FG-P2-07 Design language migration | not_started | — | 31B tokens 未迁移到生产 CSS |
| [ ] | FG-P2-08 Accessibility implementation | not_started | — | 无 a11y 实现 |

## 功能组清单 — Phase 3: 三元语视图（M3 门控）

| 勾选 | 功能组 | 状态 | Packet | 说明 |
| --- | --- | --- | --- | --- |
| [ ] | FG-P3-01 裁决收件箱 | blocked | — | 入口未达成；轨 1 原型（operator-gui-v2，mock）可先行验证 inbox 形态 |
| [ ] | FG-P3-02 决策池 | blocked | — | 依赖 TP-M3-06 覆盖度查询 |
| [ ] | FG-P3-03 Fact chips + Fact Inspector | blocked | — | 依赖 E58 fact 账本（TP-M3-05）落地 |
| [ ] | FG-P3-04 Graph 真投影接入 | blocked | — | 依赖 TP-M3-06 RelationGraphProjection |
| [ ] | FG-P3-05 Overview 一屏三问 | blocked | — | ①③ 问依赖 decision 投影与 check 信号；不另立 Dashboard |

## 功能组清单 — Phase 4: 产品化与分发

| 勾选 | 功能组 | 状态 | Packet | 说明 |
| --- | --- | --- | --- | --- |
| [ ] | FG-P4-01 Task Closeout 工作台 | not_started | — | 无 A 轴收口 UI（原 Review Workbench 语义已按 41 §3.5 改判） |
| [ ] | FG-P4-02 Settings view | not_started | — | 无设置视图 |
| [ ] | FG-P4-03 macOS packaging & signing | not_started | — | 无 macOS 安装包 |
| [ ] | FG-P4-04 Windows packaging & signing | not_started | — | 无 Windows 安装器 |
| [ ] | FG-P4-05 Linux packaging | not_started | — | 无 Linux 安装包 |
| [ ] | FG-P4-06 Auto-update | not_started | — | 无自动更新器 |
| [ ] | FG-P4-07 Distribution gate | not_started | — | 未执行三平台安装测试 |

## 功能组清单 — Phase 5: SSH 远程访问

| 勾选 | 功能组 | 状态 | Packet | 说明 |
| --- | --- | --- | --- | --- |
| [ ] | FG-P5-01 SSH Tunnel Manager | not_started | — | 无 tunnel 管理代码 |
| [ ] | FG-P5-02 Remote Daemon Discovery | not_started | — | 无发现机制 |
| [ ] | FG-P5-03 CLI remote 命令 | not_started | — | 无 `harness remote` 子命令 |
| [ ] | FG-P5-04 Remote Project 视图激活 | not_started | — | 远程项目区仍为占位空态 |

## 前置条件清单

以下 4 项为 Phase 0 前置条件，必须在 Phase 1 正式开工前完成或明确 ADR：

- [ ] React 状态管理 ADR 签署（FG-P0-01）
- [ ] Electron E2E 测试框架 ADR 签署（FG-P0-02，受 ADR-0015/E57 边界约束）
- [ ] Application 层同步 I/O 异步迁移合并或 daemon-side async wrapper ADR（FG-P0-03）
- [ ] Accessibility 基线声明签署（FG-P0-04）

## 历史审查遗留（退出条件核对项）

`../../foundation/m2-5-gui/03-review-action-matrix.md` 中 deferred/moved 的 GUI 侧项，GUI-V1 排期须逐项接住或显式记 residual：

- [ ] F3 WriteCoordinator 远程并发策略（deferred，`harness/contracts/37`）——Phase 5 远程工作流前须明确
- [ ] F4 Daemon API 契约 Doc 39 拆分（deferred_to_m_gui_v1）——Phase 1 开发时择机拆分

## known-deferred

- [ ] `GUI-V1/TaskTree`: PLT-TaskTree 完成后增量添加父子树状视图。当前 GUI 不展示父子关系，待 PLT-TaskTree Relation kernel 落地后作为增量 FG 添加到本里程碑或后续维护里程碑。
- [ ] `GUI-V1/AdapterSnapshot`: PLT-Adapter 完成后增量添加外部 adapter 快照显示。当前 GUI 只展示本仓 adapter 数据，待外部 adapter 只读 snapshot 可用后增量添加集成视图。
- [ ] `GUI-V1/FactLayer2`: fact 聚合/全文检索/权重/跨 task 浏览显式 defer 到 M3 dogfood + M4 之后（41 §3.4 Layer 2）；触发条件 = Layer 1 明确解决不了的真实案例清单。
- [ ] `GUI-V1/Weathering`: 风化警示（Overview ③ 增强、决策池"需复核"标记）待 M4 TP-M4-01 落地后作 Phase 3 增量接入。
