# GUI-V1 · 功能拆解 (Feature Breakdown)

- **状态**: canonical
- **日期**: 2026-06-14（**2026-07-02 三元语改版**：Phase 重排为 0–5，拆出独立三元语视图 phase（M3 门控）；FG-P2-04/05 从 Goals/Notes 视图改为 Task Board/List 与 Task Detail + Doc Viewer；新增 FG-P1-07 decision ops handler 域；原 FG-P2-09/P2-10/P3-02 移入 Phase 3 并按 41 重定义；INV-7 残留清除（E50 已删）；**2026-07-07 daemon pivot re-charter（dec_mr9z0b7m active）**：Phase 1 FG-P1-01..06 由「自建 daemon runtime」改为「消费 PLT-Daemon 的客户端接入」——daemon server/JSON-RPC dispatch/PTY/lifecycle/CLI-daemon-mode 的**权威实现归 PLT-Daemon W1–W8**，GUI 侧只保留对应客户端消费 FG；本地集成待 daemon W5、远程待 W7）
- **日期注**: 2026-07-07 re-chartered per dec_mr9z0b7m: 自建 daemon 剥离归 PLT-Daemon, GUI-V1 消费不自建。
- **入口条件**: M2.5-GUI + PLT-Daemon（本地集成待 daemon W5 #245 合并；远程依赖 W7）
- **来源**: 00-overview.md、`40-gui-and-apps/41-triadic-gui-information-architecture.md`（视图语义权威源 / canonical IA 目标；31/31B 部分过时）、`40-gui-and-apps/31-local-gui-spec.md`（壳层/终端）、`harness/contracts/39-daemon-api-service-contract.md`、ADR-0003/0004/0005/0006/0013/0015
- **目的**: 把 GUI-V1 从单页 overview 拆成可派工的任务包候选。FG → task packet 派工仍继承 `harness/milestones/00-packet-contract-template.md`，写入具体 `reading_list`；**packet 账本落在 GUI-V1 主协调任务（module `gui-v1`）**。

---

## Phase 0: 技术选型与前置条件（40 号文档 4 个 PRE 原样）

| 功能组 | 内容 | 交付物 |
| --- | --- | --- |
| FG-P0-01 React 状态管理选型（PRE-02） | 在 TanStack Query / Zustand / Effect-based 方案中选定 GUI 状态管理策略 | ADR 文档，含选型理由、对 daemon 数据流的适配分析、与 Effect 生态的兼容性评估 |
| FG-P0-02 Electron E2E 测试选型（PRE-03） | **受 ADR-0015/E57 约束**：Vitest 已定为 GUI unit/component canonical runner，本 FG 只裁 E2E driver（Playwright for Electron 或等价方案），不重裁 unit runner | ADR 文档，含 E2E 框架选型、CI 集成方案；首个 GUI Vitest 测试落地时按 E57 ② 新增明确 check lane 并接入 `npm run check` / PR gate |
| FG-P0-03 Application 层异步 I/O 迁移（PRE-01） | 将 `LocalControllerService` 同步 I/O 替换为 Effect async，关闭 M2.5-GUI deferred blocker | Application read path 全量异步化；回归测试通过；M2.5 deferred blocker 关闭 |
| FG-P0-04 Accessibility Baseline（PRE-04） | 建立 WCAG 2.1 AA 键盘导航基线声明 | Accessibility 基线文档，含键盘导航矩阵、焦点管理规范、ARIA 标签约定 |

---

## Phase 1: Daemon 消费接入（consume PLT-Daemon，不自建）

> **2026-07-07 re-charter（dec_mr9z0b7m）**：daemon runtime 的**服务端实现**（HTTP/WS server、JSON-RPC dispatch、handler 派生、PTY 生命周期、PID/idle/graceful shutdown、`harness daemon` 子命令）**权威归属 PLT-Daemon W1–W8**（见 `../../platform/plt-daemon/00-overview.md`），GUI-V1 **不自建**。下表 FG 全部收敛为 GUI 侧的**客户端消费**能力：消费 PLT-Daemon 提供的 JSON-RPC daemon，GUI 做协议客户端（hello handshake / transport client / RBAC-aware actor display），不做 daemon 服务端。ground-truth（2026-07-07）：daemon W1/W2/W3/W4/W6 已合入 main；本地 serve loop 待 W5（PR #245）合并；远程服务器模式待 W7。

| 功能组 | 内容 | 交付物 |
| --- | --- | --- |
| FG-P1-01 传输客户端连接 | 消费 PLT-Daemon W3 传输库：Unix socket / named pipe 本地连接、重连、健康探测（远程 SSH-tunnel 属 Phase 5） | GUI 可连上运行中的 daemon 端点并保活；**实活集成待 daemon W5 serve loop 合并** |
| FG-P1-02 JSON-RPC 客户端层 | 消费 W2 协议：`protocol.hello` 版本协商握手（不兼容即拒）、请求/响应/错误码（-32600/-32601/-32602/-32603）消费、batch 支持 | JSON-RPC client，含 typed method 调用、错误映射到 GUI 态；协议级消费测试 |
| FG-P1-03 命令消费面（client） | 消费 daemon `repo.*` 方法（task 域从 `api-contract-registry` 派生，与 CLI 同源）；GUI 只做视图消费，无私有业务 API（41 P4/P5） | 契约注册表中 active 的 task route 在 GUI 侧有对应客户端调用；请求/响应绑定冻结契约字段 |
| FG-P1-04 Terminal attach（client） | 消费 daemon 托管 PTY session：over 传输通道 attach、stdin/stdout streaming、resize、关闭 | GUI 终端可 attach daemon PTY、收发输出、resize（渲染在 Phase 2 FG-P2-06） |
| FG-P1-05 身份/RBAC 感知（client） | 消费 W4 身份面：GUI 只上报 `runtime`+`sessionId`，**不自称 person**（dec_mr9ac5ca）；显示 daemon 盖章的 actor；消费 `admin.*` 命名空间 | actor 显示来自 daemon 盖章；RBAC 受限操作按 daemon 判定渲染可用/禁用；不伪造身份 |
| FG-P1-06 连接生命周期（client） | 消费 W5 thin-client 模式：单用户自动起停/idle-exit 的**客户端侧**协同（daemon 端逻辑归 W5，GUI 只做连接态管理与自动重连） | GUI 连接态机：断线检测、自动重连、daemon 未起时的引导；不实现 daemon 端 PID/shutdown |
| FG-P1-07 Decision ops 消费（client，新增） | 消费 daemon 侧 decision write ops（propose/accept/reject/defer/supersede/amend/retire）的客户端调用 | decision ops 经 daemon 客户端可调通；**依赖 M3 第一梯队（TP-M3-03b/04）exit + daemon 暴露该域**后接入，属 Phase 3 门控前置；当前 main 上 decision/fact 客户端读写面尚不存在（apiRouteContracts 零命中），不阻塞其余 FG |

---

## Phase 2: Electron Shell + Task 操作面（与 M3 零耦合，可先行）

| 功能组 | 内容 | 交付物 |
| --- | --- | --- |
| FG-P2-01 Electron main process | BrowserWindow creation、system tray、IPC handler registration per 31A security contract | Electron main 进程，含安全 IPC 通道注册、窗口生命周期管理、系统托盘集成 |
| FG-P2-02 IPC bridge | contextBridge typed channels per allowlist、daemon client connection | 类型安全 IPC bridge，renderer 只经 allowlist 通道与 main 通信；main 连接 daemon |
| FG-P2-03 Workspace shell | Sidebar、perspective switcher、pane container per ADR-0003 | 工作区壳层 UI：侧边栏导航、视角切换器、面板容器；支持 tab/split 布局 |
| FG-P2-04 Task Board/List 视图（原 Goals view 改） | 31 §3.1 看板/列表语义（coordinationStatus 6 态分列、审计表格、批量 task 操作）+ 41 §3.3 增量：spawningDecision 徽章、从 decision 派生 task 入口——**徽章/派生入口在 Phase 3 才有真数据，此处只留组件位** | Task Board/List 完整视图：列表筛选、状态流转、31B 三轴视觉通道（task 专属，41 §3.7）；徽章/派生入口组件位就绪 |
| FG-P2-05 Task Detail + Doc Viewer（原 Notes view 改） | task 包文档渲染，progress/findings 叙事文档渲染，F-id chip 组件位（Fact Inspector 在 Phase 3 接通） | Task Detail 面板 + Doc Viewer：task 包内文档可浏览、叙事 markdown 渲染、F-id 锚渲染为 chip 组件位 |
| FG-P2-06 Terminal view | xterm.js 集成、daemon PTY session attach per ADR-0004 | 终端面板：xterm.js 渲染、attach daemon PTY session、输入/输出/resize |
| FG-P2-07 Design language migration | OKLch tokens、component specs from 31B prototype to production CSS | 设计令牌迁移到生产 CSS：OKLch 色彩、排版比例尺、间距系统、组件规格 |
| FG-P2-08 Accessibility implementation | 键盘导航、焦点管理、ARIA labels | 全视图键盘可达；焦点环可见；ARIA 正确；符合 FG-P0-04 基线声明 |

---

## Phase 3: 三元语视图（入口 = M3 TP-M3-06 exit + TP-M3-12b 基准可用 + FG-P1-07）

| 功能组 | 内容 | 交付物 |
| --- | --- | --- |
| FG-P3-01 裁决收件箱（原 FG-P2-09 Decisions View 移入并按 41 §3.1 重定义） | tab 浏览形态 → inbox 队列形态：proposed 按 riskTier × urgency 排序、逐条聚焦、可跳过；裁决卡必显项（chosen/rejected+why_not、两轴徽章、证据 fact chips、relation 上下游、provenance）；**裁决就绪信号灯（41 §3.1a）**：evidence 活性/applies_to 漂移黄灯、覆盖度/冲突标记红灯——全绿直接裁，黄红警示 + "呼叫 Agent 核查"升为推荐动作（不强拦，E50）；accept/reject/defer 经 daemon service（FG-P1-07），冲突标记下 accept 被 coordinator 预检拒绝、GUI 渲染拒因；**accept 成功后若裁决声明需正文回写 → 提示派生回写 task（42 §4）**；保留 rationale（INV-5）渲染与右侧分屏 terminal 人机对话（31 §3.11 继承，预填 `/decisions`）；**删除 Sybil 警示 INV-7——E50 已删该不变量，原 FG 引用是过时残留** | 收件箱 pane：队列/裁决卡/三操作/信号灯/空队列态；41 §3.1 反模式清单逐条核对（禁批量裁决、三操作视觉等权、不内联 A 轴 checklist、写只走 daemon service）；信号灯黄红场景的 agent 推荐路径可走通 |
| FG-P3-02 决策池（41 §3.2） | proposed/active/retired 三态 tab（rejected/deferred 归 proposed tab 历史折叠区）；覆盖度指示（可达性非统计）；supersede/amend 链导航；state/riskTier/urgency/proposedBy kind/时间过滤 | 决策池视图：三态浏览、覆盖度绿/警示指示、演化链可视化；不提供覆盖度百分比统计排序 |
| FG-P3-03 Fact chips + Fact Inspector（41 §3.4 Layer 1） | F-id 证据 chip（锚 `task_x/F-xxxx`，TP-M3-05）只出现在被引用处；**数据源 = E58 fact 账本文档**；Inspector 侧板：原文/所在 task 包/provenance/入边 relation；活/已失效/悬空三渲染态（悬空接 INV-6） | chip 组件 + Inspector pane；零 fact 操作零聚合（Layer 2 显式不做）；fact 无顶层列表、无导航项 |
| FG-P3-04 Graph 真投影接入（原 FG-P2-10 移入，41 §3.6） | decision→task→fact 闭环链路高亮、按 module 分区（Cluster）展示；**数据面锁定 RelationGraphProjection 只读 SQL（TP-M3-06），不得 mock 边/自建边推导常驻**；环检测警示接 INV-3 | Graph View 接真投影：链路高亮、环警示标记；高频查询不裸扫 markdown；单仓范围（跨仓归 GUI-V2） |
| FG-P3-05 Overview 一屏三问（并入原 FG-P3-02 Dashboard，不再另立 Dashboard FG） | 41 §2 三问：①今天要裁什么（proposed top N → 收件箱）②现在在跑什么（task 分布 + 异常滞留 → 看板筛选）③什么在风化（V1 = INV-4/INV-6/投影 freshness 机械信号；M4 后接风化查询）；每个 widget 标注回答哪一问 + 点击落点 | Overview 首屏：三问 widget、P6 判据逐项核对、vanity 指标禁入（41 P6） |

---

## Phase 4: 产品化与分发

| 功能组 | 内容 | 交付物 |
| --- | --- | --- |
| FG-P4-01 Task Closeout 工作台（原 FG-P3-01 Review Workbench 改名） | **A 轴机械收口**（41 §3.5）：task gates/checks、收口材料就绪度；与 B 轴裁决收件箱导航分离（不合并为一个 Review 入口）；31 §3.6 交互资产（子队列分组、对比模式、批量 passed/failed、侧栏统计）按需保留 | Closeout 工作台三栏布局；verdict 只写 task 的 closeoutReadiness 轴（31 §3.2 规则不变），人审写入走 kernel 所有权护栏 |
| FG-P4-02 Settings view（原 FG-P3-03） | Engine config、preset management、daemon config | 设置视图：引擎配置编辑、preset 管理、daemon 参数（idle timeout / socket path）调整 |
| FG-P4-03 macOS packaging & signing（原 FG-P3-04） | Electron Forge/Builder、Apple code signing、notarization | macOS `.dmg` / `.app`；Developer ID 签名；公证通过 |
| FG-P4-04 Windows packaging & signing（原 FG-P3-05） | NSIS/Squirrel installer、Authenticode signing | Windows `.exe` / `.msi`；Authenticode 签名；SmartScreen 无警告 |
| FG-P4-05 Linux packaging（原 FG-P3-06） | AppImage/deb/rpm 打包 | Linux 安装包；主流发行版安装验证 |
| FG-P4-06 Auto-update（原 FG-P3-07） | Electron autoUpdater with signed updates | 检测/下载/验签/安装更新；支持 staged rollout |
| FG-P4-07 Distribution gate（原 FG-P3-08） | 3-platform install test、no security warnings | 三平台安装测试通过；无安全警告；卸载干净 |

---

## Phase 5: SSH 远程访问（原 overview Phase 4 平移；本表为首次成表拆解）

| 功能组 | 内容 | 交付物 |
| --- | --- | --- |
| FG-P5-01 SSH Tunnel Manager | 调用系统 `ssh`，连接生命周期管理，断线重连（ADR-0005） | tunnel 建立/断开/重连；断线状态 UI 不崩溃 |
| FG-P5-02 Remote Daemon Discovery | 手动配置远端 host + 可选 mDNS 局域网发现 | 远端配置持久化；mDNS 可发现同网段 Daemon |
| FG-P5-03 CLI remote 命令 | `harness remote add/remove/list` | remote 子命令注册与配置读写 |
| FG-P5-04 Remote Project 视图激活 | 「远程项目」占位区从空态 → 可用；远端 task/terminal 操作与本地体验一致（共用 Daemon API contract） | 远程项目列表；远程 task CRUD + Terminal 与本地同面 |

---

## 任务包映射说明

每个 FG 映射到一个或多个 task packet，正式派工时必须继承 `harness/milestones/00-packet-contract-template.md` 模板结构，packet 账本记录在 module `gui-v1` 主协调任务下。每个 task packet 必须包含：

- 具体 `reading_list`（Phase 3 各 FG 的 reading_list 必含 `40-gui-and-apps/41-triadic-gui-information-architecture.md` 对应小节）
- 明确的 exit evidence
- 前置 FG 依赖声明（Phase 3 packet 须显式声明 M3 门控：TP-M3-06/12b exit + FG-P1-07）

FG 编号与 packet 编号不必一一对应；一个 FG 可拆分为多个 packet（如 FG-P1-03 按 handler 域拆分），也可将多个小 FG 合并为一个 packet（如 FG-P0-01 + FG-P0-02 合并为一个选型 packet）。
