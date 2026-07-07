# GUI-V1 · V1 本地桌面客户端 (Local Desktop GUI V1)

- **状态**: canonical
- **日期**: 2026-06-14（2026-06-14 新增 SSH 远程 + 桌面通知；**2026-07-02 三元语改版**：视图语义权威源改挂 `../../../40-gui-and-apps/41-triadic-gui-information-architecture.md`（定稿 canonical），Phase 重排为 0–5——拆出独立"三元语视图"phase 并挂 M3 门控，Goal/Note 旧词汇清除（Multica 时代残留，本产品实体是 task/decision/fact），INV-7 残留清除（E50 已删该不变量）；**2026-07-07 daemon pivot re-charter（锚 dec_mr9z0b7m active）**：自建 daemon runtime 剥离归 PLT-Daemon，GUI-V1 瘦身为「消费 PLT-Daemon」——原 Phase 1「Daemon Runtime」由自建改为消费（JSON-RPC 客户端 + hello 握手 + 传输客户端 + RBAC 感知的 actor 显示）；入口条件补 PLT-Daemon 依赖（本地集成待 daemon W5、远程待 W7）；锚四裁决 dec_mr9abn9x/ac5ca/acscw/acuxm）
- **日期注**: 2026-07-07 re-chartered per dec_mr9z0b7m: 自建 daemon 剥离归 PLT-Daemon, GUI-V1 消费不自建。
- **产品线**: 桌面端线 (GUI)
- **来源**: [2026-06-14 M2.5 架构设计审查](../../foundation/m2-5-gui/reviews/2026-06-14-m25-architecture-design-review.md) → [GUI-V2 拆分策略对抗式审查](reviews/2026-06-14-m6-split-strategy-review.md) → 2026-06-14 产品线重构 → 2026-07-02 三元语 GUI 信息架构定稿（`../../../40-gui-and-apps/41-triadic-gui-information-architecture.md`，canonical IA；31/31B 部分过时）

## 目标 (North Star)

V1 本地 Electron 桌面客户端上线，产品形态 = 三元语内核（decision/task/fact）的桌面操作面：**task 看板/列表是日常操作面，裁决收件箱是 killer view，fact 以证据 chip 嵌入被引用处**（41 P1 对称破缺复制）。壳层/安全/daemon/terminal 继续承接 `31-local-gui-spec.md` §1–§2、31A、39、ADR-0003/0004/0005；**视图语义权威源 = 41**（31 §3 视图定义已被其取代）。GUI 是 Daemon 的视图消费者，一切写操作经与 CLI 相同的 Service → WriteCoordinator → Git（41 P4/P5：投影只读、写路径同面，GUI 不得出现私有业务 API）。V1 只管本仓 local 操作，不做跨仓聚合。

## §0. 为什么独立里程碑

V1 GUI 的技术依赖链在 2026-07-07 re-charter 后是 **M2.5-GUI + PLT-Daemon → GUI-V1**。它不依赖 PLT-TaskTree（父子任务）、PLT-Adapter（外部 adapter）、PLT-CrossRepo（跨仓引用）。原路线图将 V1 与 V2 捆绑到 GUI-V2（入口条件为 PLT-Adapter+PLT-CrossRepo 完成），人为制造了数月的不必要延迟。2026-06-14 架构审查发现此依赖链错误，决定将 V1 GUI 独立为 GUI-V1。三元语改版后新增一条依赖纪律：**只有 Phase 3（三元语视图）受 M3 门控，Phase 0/1/2 与 M3 内核实现零耦合**，不得以"等 M3"为由停摆基建。

## §0.5 三轨并行结构（对齐 41 §5）

| 轨 | 内容 | 与 M3 的关系 |
| --- | --- | --- |
| 轨 1 | 原型收件箱形态验证：`prototypes/operator-gui-v2`（mock 数据）按 41 §3.1 把 tab 式 `DecisionsView` 演进为 inbox 队列形态（排序、逐条聚焦、裁决卡必显项），验证信息密度；同步修正原型残留的 INV-7 Sybil 强预警语义（41 §7） | 与实现并行，不接真实 CLI/coordinator；feeds Phase 3 设计定版 |
| 轨 2 | Phase 0/1/2：前置条件 + PLT-Daemon 客户端消费接入 + Electron Shell/Task 操作面 | 与 M3 实现零耦合，立即推进 |
| 轨 3 | Phase 3：三元语视图接真投影与真写路径 | M3 门控（入口条件见下） |

Phase 4/5 顺序排在 Phase 3 之后。三轨可真并行：轨 2 不等 M3，轨 1 不阻塞轨 2，轨 3 只在 M3 第二梯队 exit 后才有真数据可接（41 §5）。

## 范围内 (In Scope)

### Phase 0: 技术选型与前置条件

`../../../40-gui-and-apps/40-gui-v1-prerequisites.md` 的 4 个 PRE 条件原样继承：

- PRE-01 Application 层同步 I/O 异步迁移（`LocalControllerService` 残余 `*Sync` 调用替换为 Effect async）
- PRE-02 React 状态管理 ADR（TanStack Query / Zustand / Effect-based 选型签署）
- PRE-03 Electron E2E 测试选型——**受 ADR-0015/E57 约束**：Vitest 已裁定为 GUI unit/component canonical runner，本项只裁 E2E driver（Playwright for Electron 或等价方案）；首个 GUI Vitest 测试落地时必须按 E57 ② 新增明确 check lane 并接入 PR gate
- PRE-04 Accessibility Baseline（WCAG 2.1 AA 键盘导航基线声明）

### Phase 1: Daemon 消费接入（consume PLT-Daemon，不自建）

> **2026-07-07 re-charter（dec_mr9z0b7m）**：daemon runtime 本身（HTTP/WS server、JSON-RPC dispatch、PTY 生命周期、PID/idle/graceful shutdown、handler 派生）**由 PLT-Daemon（W1–W8）提供，GUI-V1 不自建**。本 Phase 只做 GUI 侧的**客户端消费层**：消费 PLT-Daemon 提供的 JSON-RPC daemon，GUI 做协议客户端（hello handshake / transport client / RBAC-aware actor display），不做 daemon 服务端。原自建条目的权威定义见 `../../platform/plt-daemon/00-overview.md` 与 Doc 39，本处不再复述。

- **JSON-RPC 客户端**：`protocol.hello` 版本协商握手（不兼容即拒），请求/响应/错误包装消费，batch 支持——对接 PLT-Daemon W2 的协议核心。
- **传输客户端**：Unix socket / named pipe 本地连接（远程 SSH-tunnel+token 属 Phase 5）——消费 PLT-Daemon W3 传输库；**本地实活集成待 daemon W5（thin-client serve loop）落地**。
- **命令消费面**：task CRUD 经 daemon `repo.*` 方法（从 `api-contract-registry` 派生，与 CLI 同源）；GUI 只做视图消费，不得出现私有业务 API（41 P4/P5）。
- **身份/RBAC 感知**：GUI 只上报 `runtime`+`sessionId`，**不得自称 person**（dec_mr9ac5ca）；person 由 daemon 依传输派生并盖章；消费 `admin.*` 命名空间供未来 admin UI。
- **终端 attach**：消费 daemon 托管的 PTY session（over 传输通道），GUI 侧只做 xterm.js attach（见 Phase 2 终端视图）。
- **decision ops 消费（FG-P1-07）**：接入 daemon 侧的 7 个 decision write ops 客户端调用；**依赖 M3 第一梯队（TP-M3-03b/04）exit + daemon 暴露该域后**接入，属 Phase 3 门控的前置。当前 main 上 decision/fact 客户端读写面尚不存在（apiRouteContracts 零命中），此项在 Phase 3 才 for-real。

### Phase 2: Electron Shell + Task 操作面（与 M3 零耦合，可先行）

- Electron main + IPC bridge + React renderer + 工作区壳层（ADR-0003）
- **Task Board/List 视图**（31 §3.1 看板/列表语义 + 41 §3.3 增量：spawningDecision 徽章、从 decision 派生 task 入口——徽章/派生入口在 Phase 3 才有真数据，此处只留组件位）
- **Task Detail + Doc Viewer**（task 包文档渲染，progress/findings 叙事渲染，F-id chip 组件位）
- Terminal 视图（xterm.js + daemon PTY attach，ADR-0004）
- Design Language 31B token 迁移 + Accessibility 实现

### Phase 3: 三元语视图（新设；入口 = M3 TP-M3-06 exit + FG-P1-07）

- **裁决收件箱**（41 §3.1）：inbox 队列形态、裁决卡必显项、accept/reject/defer 三操作、反模式清单照 41 逐条执行
- **决策池**（41 §3.2）：proposed/active/retired 三态、覆盖度指示（可达性非统计）、supersede/amend 链
- **Fact chips + Fact Inspector**（41 §3.4 Layer 1）：数据源 = E58 fact 账本；Layer 2 显式不在 V1
- **Graph 真投影接入**（41 §3.6）：数据面锁定 RelationGraphProjection 只读 SQL
- **Overview 一屏三问**（41 §2）：不另立 Dashboard FG，vanity 指标禁入（41 P6）

### Phase 4: 产品化与分发

- **Task Closeout 工作台**（原 Review Workbench 改名：A 轴机械收口，41 §3.5，与 B 轴裁决收件箱导航分离）
- Settings 视图（引擎配置、preset 管理、daemon 参数）
- macOS/Windows/Linux 打包签名公证、自动更新器、分发门禁（原样）
- 桌面通知集成（原生通知 API，消费 PLT-Notify 事件总线）

### Phase 5: SSH 远程访问（原 Phase 4 原样平移）

- SSH Tunnel Manager（调用系统 `ssh`，连接生命周期管理，断线重连）
- Remote Daemon Discovery（手动配置远端 host + 可选 mDNS 局域网发现）
- GUI Remote Project 视图激活（「远程项目」占位区从空态 → 可用）
- CLI `harness remote add/remove/list` 命令
- 远端 Daemon 的 task/terminal 操作与本地体验一致（共用 Daemon API contract）

## 范围外 (Non-goal)

- V2 跨仓聚合只读视图——GUI-V2 负责（decision/fact 跨仓表达见 41 Q2）
- **Fact Layer 2 能力**（聚合、全文检索、重要性权重、跨 task 浏览器）——显式 defer 到 M3 dogfood + M4 之后（41 §3.4 Layer 2，defer 理由已写明，不得当遗漏补上）
- 风化可视化——依赖 M4 TP-M4-01，落地后作 Phase 3 增量接入（41 §2 ③）
- 账号系统/多端同步/手机端——COM-Sync/COM-Mobile 负责
- cloud relay / browser mobile live terminal / 跨 NAT 中转——需另立产品决策
- 外部 adapter 集成视图——PLT-Adapter 数据可用后增量添加
- 父子任务树状视图——PLT-TaskTree 完成后增量添加
- 邮件/Webhook/Slack 等远程通知通道——PLT-Notify 负责

## 入口条件

**里程碑入口**（2026-07-07 re-charter 后 = `M2.5-GUI + PLT-Daemon`，与 `../../00-roadmap.md` GUI-V1 行一致）：

1. M2.5-GUI 验收通过（daemon/API/terminal/distribution 契约就绪）——已收口（`../../foundation/m2-5-gui/03-review-action-matrix.md` review-ledger-closed）。✅
2. **PLT-Daemon 提供可消费的 daemon runtime**（dec_mr9z0b7m）：Phase 1 客户端消费接入以此为前提。分级依赖——**本地实活集成待 daemon W5（thin-client serve loop）合并**；**远程依赖 W7（服务器模式 + SSH-tunnel 接线）**。设计/前置/task 外壳（Phase 0、Phase 2）与 daemon 就绪度**零耦合，可先行**。

**Phase 1 入口**（40 号文档纪律不变）：

3. Phase 0 的 4 个 PRE 条件**全部关闭**（PRE-01 异步 I/O、PRE-02 状态管理 ADR、PRE-03 E2E 选型 ADR、PRE-04 a11y 基线）；未全部关闭前 Phase 1 消费接入不得启动实现。

**Phase 3 入口**（M3 门控，新增）：

3. M3 TP-M3-06（RelationGraphProjection）exit；
4. TP-M3-12b 覆盖度自宿主验证基准可用（E45/E47 回填实例的覆盖度查询）；
5. FG-P1-07 decision ops handler 域可用。

Phase 2 与 M3 零耦合，不受 Phase 3 门控约束。

## 验收标准

### Phase 0

- [ ] 所有前置 ADR 签署（E2E 选型 ADR 注明 ADR-0015 边界：只裁 E2E driver，不重裁 unit runner）
- [ ] 异步 I/O 迁移合并
- [ ] E2E 测试框架可运行空测试

### Phase 1

- [ ] GUI JSON-RPC client 可完成 `protocol.hello` 握手、错误映射和 batch 消费
- [ ] GUI transport client 可连接 PLT-Daemon 本地端点并维持连接态；**本地实活集成待 daemon W5 #245 合并**
- [ ] GUI terminal view 可 attach daemon 托管 PTY 并收发流；daemon PTY 服务端不归 GUI-V1
- [ ] FG-P1-07：decision ops client 可消费 daemon 暴露的 decision write ops（本条按 Phase 3 门控节奏验收，不阻塞 Phase 1 其余项收口）

### Phase 2

- [ ] `npm run dev` 可打开 Electron 窗口
- [ ] task 流程可走通：new-task 创建 → 状态流转 → progress/findings 叙事渲染 → terminal 操作
- [ ] 终端可输入命令并看到输出
- [ ] Design Language tokens 已应用；键盘导航符合 PRE-04 基线

### Phase 3（按 41 新写）

- [ ] 裁决收件箱可对自宿主真实 proposed decision 完成 accept/reject/defer，且写入经 daemon service 落 Git（41 P5 同面写路径）
- [ ] Overview 三问每个 widget 可点入对应可操作视图（41 P6 判据：回答哪一问 + 点击落点，两项缺一即删）
- [ ] fact chip 点开 Fact Inspector 显示原文/provenance/入边 relation
- [ ] Graph 显示 decision→task→fact 链路，环警示（INV-3）可见
- [ ] 覆盖度指示与 TP-M3-12b 自宿主基准一致
- [ ] **禁批量裁决**：41 §3.1 反模式清单逐条核对纳入验收（无批量勾选一键 accept；accept/reject/defer 三操作视觉等权；收件箱不内联 A 轴 checklist；不自建写端点）

### Phase 4

- [ ] Task Closeout 工作台可用：verdict 只写 task 的 closeoutReadiness 轴（31 §3.2 规则不变），导航与裁决收件箱分离（不合并为一个 Review 入口）
- [ ] macOS/Windows/Linux 安装包可生成；安装后无系统安全警告
- [ ] 自动更新器可检测并安装新版本
- [ ] 桌面通知：任务进入 `close-ready` 时弹出系统通知

### Phase 5

- [ ] `harness remote add user@host` 可配置远端 Daemon
- [ ] GUI 可通过 SSH tunnel 连接远端 Daemon 并显示远程项目列表
- [ ] 远程项目的 task CRUD + Terminal 操作与本地体验一致
- [ ] SSH 连接断开时 GUI 显示断线状态，不崩溃；自动重连
- [ ] 局域网 mDNS 发现可找到同网段的 Daemon 实例

## 依赖

- 前序里程碑：M2.5-GUI（已收口）
- 内核门控：M3 第一梯队（TP-M3-03b/04）→ FG-P1-07；M3 第二梯队（TP-M3-06/12b）→ Phase 3 入口；M4（TP-M4-01 风化查询）→ Phase 3 后增量，非本里程碑阻塞项
- 可并行里程碑：PLT-TaskTree（无技术依赖）、PLT-Adapter（无技术依赖）
- 通知基础：PLT-Notify（事件总线，桌面通知消费）
- 关键设计文档：
  - `40-gui-and-apps/41-triadic-gui-information-architecture.md`（**视图语义权威源 / canonical IA 目标**；31/31B 部分过时）
  - `40-gui-and-apps/31-local-gui-spec.md`（§1–§2 壳层/安全/daemon/terminal 继续有效；§3 视图定义已被 41 取代）
  - `40-gui-and-apps/31A-electron-security-contract.md`
  - `40-gui-and-apps/31B-gui-design-language.md`（三轴视觉通道为 task 专属，decision/fact 渲染规则按 41 §3.7）
  - `40-gui-and-apps/39-workspace-terminal-architecture.md`
  - `40-gui-and-apps/40-gui-v1-prerequisites.md`（4 个 PRE 条件）
  - `harness/contracts/39-daemon-api-service-contract.md`
  - `ha decision show E58`（fact 账本，Fact Inspector/chip 的渲染数据源）、`ha decision show E57` / ADR-0015（Vitest/ESLint 工具链边界）
  - ADR-0003（工作区面板布局）、ADR-0004（终端架构）、ADR-0005（远程 daemon）、ADR-0006（分发与更新）、ADR-0013（D4：daemon handler 从 Service contract registry 派生）

## 退出条件

- [ ] Phase 0–5 验收标准全部满足
- [ ] 用户可从 Release 页面下载安装桌面客户端
- [ ] 本地 + 远程操作均可端到端走通
- [ ] 历史审查遗留已消化：`../../foundation/m2-5-gui/03-review-action-matrix.md` 中 deferred/moved 的 GUI 侧项（如 F3 WriteCoordinator 远程并发、F4 Doc 39 拆分）已逐项接住或显式记 residual，不得以"已文档化"充当关闭证据
- [ ] Opus/reviewer 第二轮定向 review 无 open P0/P1
