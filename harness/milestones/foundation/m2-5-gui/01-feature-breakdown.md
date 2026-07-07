# M2.5-GUI · Feature Breakdown

- **状态**: closed-for-m2-5-contract-ready
- **日期**: 2026-06-14
- **来源**: M2.5-GUI overview、harness/contracts/39、ADR-0003/0004/0005、GPT 深度审查报告、Opus 对抗审阅 P2/P3 建议
- **目的**: 把 M2.5 从单页 overview 拆成可派工的任务包候选。正式派工时仍必须继承 `harness/milestones/00-packet-contract-template.md`，并写入具体 `reading_list`。

## 0. M2.5 目标

M2.5-GUI 不是 GUI v2 完整实现，也不是 PLT-TaskTree 父子任务。它是 GUI/daemon 产品化硬化层：确保 application Service surface 可以被 daemon、GUI workspace、terminal、remote 和未来多端路线复用，而不产生 CLI/GUI/daemon 三套业务逻辑。CLI dogfood、Legacy Intake、parser 拆分和 template/preset/check 接线归 `../m2-5-cli/`。

## 1. Packet 候选

| Packet | 目标 | 前置阅读 | 主要产出 | Exit evidence |
| --- | --- | --- | --- | --- |
| TP-M2.5-01 Service Mappability Gate | 把 application Service input/output 可映射性变成可检查约束，阻止 `any`/长期 `unknown` surface 扩散 | `harness/contracts/39-daemon-api-service-contract.md` §7、`harness/contracts/17-effect-ts-implementation-contract.md`、`governance/standards/implementation-contract-standard.md` | lint/check 规则、fixture、失败示例、task packet gate 文案 | `npm run check` 或等价 targeted check 可阻止新增不可映射 Service |
| TP-M2.5-02 Daemon API Contract Registry | 建立 daemon REST/WS contract registry 的单一事实源，避免 GUI spec route 草案和 handler 代码漂移 | `harness/contracts/39` §2–§4、`40-gui-and-apps/31-local-gui-spec.md` §5.1 | API registry schema、route ownership matrix、schema single-source rule | contract registry 与 GUI route 草案差异可报告 |
| TP-M2.5-03 Terminal Session Registry | 固化 `TerminalSessionInfo`、session lifecycle、attach/close/reopen、active terminal 聚合视图 | `harness/contracts/39` §5、ADR-0004、`40-gui-and-apps/39-workspace-terminal-architecture.md` | session registry model、terminal lifecycle tests、scrollback config policy | 可创建/列出/attach/关闭 fake 或 real terminal session；metadata 不依赖 GUI local state |
| TP-M2.5-04 Durable Terminal Backend Spike | 验证 `tmux` 或等价 detach/resume backend 是否可作为 baseline；明确 direct-pty 降级语义 | ADR-0004、`harness/contracts/39` §5、`31A-electron-security-contract.md` | tmux backend spike、platform notes、cleanup/reconnect/namespace policy | 关闭 GUI/daemon 后 session attach 行为有实验证据；不支持平台有降级说明 |
| TP-M2.5-05 Remote Daemon over SSH Tunnel | 设计并验证 remote daemon token bootstrap、tunnel lifecycle、host profile trust/revoke | ADR-0005、`harness/contracts/39` §6、`35-gui-v2-vision.md` §2.3 | host profile schema、token exchange lifecycle、tunnel registry、revoke flow | 本地 GUI 可通过 tunnel 调 remote daemon mock；token 不落 repo/scrollback |
| TP-M2.5-06 Workspace Shell Prototype Upgrade | 把 operator GUI 原型从 page-view 继续推进到 dockable pane shell spike | ADR-0003、`40-gui-and-apps/39-workspace-terminal-architecture.md`、`31B-gui-design-language.md`、PROTO-02 task_plan | dockview 或等价 spike、OpenTarget router、pane metadata、layout persistence demo | task、doc、terminal、log 至少三类 pane 可 tab/split/dock/restore |
| TP-M2.5-07 Distribution and Update Architecture | 形成 desktop app + daemon 的 macOS/Windows/Linux 分发、签名、升级、未签名限制和 remote daemon bootstrap 设计 | `harness/milestones/m2-5.../00-overview.md` §2/§4、`31A-electron-security-contract.md`、platform packaging docs | distribution ADR 或 contract、release channel model、manual/auto update policy | reviewer 能据此创建 packaging/signing/update 实现任务 |
| TP-M2.5-08 Product-Line Documentation Hardening | 让 README 地图、decision ledger、ADR、milestones、task packet template 支撑后续 PLT-TaskTree/PLT-Adapter/PLT-CrossRepo/GUI-V2 派工 | `ha decision list/show`、`harness/adr/`、`harness/milestones/README.md` | reading_list gate、M2.5 breakdown、product-line map 修订 | 新 agent 能从 root README 找到 M2.5/PLT-TaskTree/PLT-Adapter/PLT-CrossRepo/GUI-V2 权威源；无重复 ADR 编号 |
| TP-M2.5-09 Electron Security Hardening | 把 GUI foundation 从安全壳推进到产品级 Electron baseline | `31A-electron-security-contract.md`、Electron security checklist、GPT 深度审查报告 | IPC sender/frame/origin 校验、permission request deny-by-default、navigation/window-open guard、browser pane threat model stub | tests 覆盖 IPC sender 拒绝；未来 browser/localhost pane 有明确 guardrail |
| TP-M2.5-10 Runtime and Release Reproducibility | 统一源码直跑、构建后跑、package smoke、Node 版本矩阵和 release readiness | `README.md`、`.github/workflows/rewrite-ci.yml`、GPT 深度审查报告 | Node 24/26 CI matrix、README 运行路径澄清、package smoke 标准、release readiness notes | `npm ci`、typecheck/test/check/package smoke 在 Node 24/26 CI 语义下明确 |
| TP-M2.5-11 Supply Chain and License Release Gate | 在正式 desktop/daemon 分发前建立 AGPL、SBOM、OSV、Dependabot、Electron upgrade 的发布门禁 | `31A-electron-security-contract.md`、distribution ADR、GPT 深度审查报告 | P11 PR #55：Dependabot entry binding、SBOM/SCA gate、OSV evidence path、license policy、AGPL network-service release checklist、release artifact SBOM boundary | release task packet 可引用，不再把 license/SCA 留到发布当天；真实 installers/artifacts 仍 deferred |
| TP-M2.5-12 Placeholder and Dormant Surface Cleanup | 把 placeholder adapter、foundation-only API、display-only shell 统一标注，降低误解 | `02-implementation-status-matrix.md`、package READMEs、GPT 深度审查报告 | package README status、exported status constants、roadmap matrix updates | GitHub/Linear/openShell/archiveTask 不再被误读为 shipped capability |
| TP-M2.5-13 Application Composition Boundary | 修复 `packages/application` 直接 import local adapter 的 composition-root 违规，并让 import-boundary checker 保护真实 application layer | `harness/milestones/foundation/m2-5-gui/reviews/m2-5-architecture-review.md` P0/P1-A、`harness/contracts/39-daemon-api-service-contract.md`、System Architecture §3 | application Service 接收最小写入依赖；CLI/GUI composition root 注入 local engine；边界 checker 覆盖 `packages/application/` 并删除 dead rule | GUI daemon work 开始前，application layer 不再绑定 local adapter，CI 能阻止回归 |
| TP-M2.5-14 GUI Bridge Handler Registry Gate | 把当前手写 GUI bridge 从 ad-hoc dispatch 收敛到 registry-gated thin handler，关闭 G-01 current bridge drift gap | `harness/milestones/foundation/m2-5-gui/reviews/m2-5-architecture-review.md` P2-C、`harness/contracts/39-daemon-api-service-contract.md` §4/§7、`packages/gui/src/api/api-contract-registry.ts` | `guiBridgeHandlerImplementations`、registry-derived shipped method set、deferred method exclusion、checker/tests | Shipped GUI bridge methods/service calls 与 `apiRouteContracts` 一致；deferred `archiveTask`/legacy `openShell` 不能进入 shipped handler；不宣称 REST/WS daemon runtime |
| TP-M2.5-15 EnvProfile and TrustPolicy Contract | 把 contract 39 §5.3 `EnvProfile` 与 §6.3 named `TrustPolicy` 落成 public code contract/gate，关闭 G-02/G-03 | `harness/contracts/39-daemon-api-service-contract.md` §5.3/§6.3、`harness/milestones/foundation/m2-5-gui/02-status-checklist.md` remaining closeout gaps、Commander F-002 | P15 PR #59 / merge `f46ccd3`: `EnvProfile` contract/helper、named daemon/browser/remote `TrustPolicy` contract/helper、contract tests、tier manifest update | Public code surface exists and is tested; no daemon runtime, secret store, PTY spawn, browser/preview product capability, or REST/WS handler claim |
| TP-M2.5-16 Second-round Closeout Review | 验证 P01-P15 evidence 是否关闭 G-01..G-08，尤其是 G-05 Opus second-round review exit criterion | Commander F-002、`08-gui-side-gaps.md`、`harness/milestones/foundation/m2-5-gui/reviews/m2-5-architecture-review.md` reconciliation table、P01-P15 task packages | P16 private review task package、Opus directed review capture、roadmap/status/finding reconciliation | No open P0/P1/P2; G-05 closed; GUI closeout complete for M2.5; daemon runtime sync I/O remains future runtime blocker |
正式派工前必须同步检查 `02-status-checklist.md` 与 `03-review-action-matrix.md`，确保每个 GPT/Opus GUI/daemon finding 都有 packet 或 ADR 改判。CLI complexity finding 改由 `../m2-5-cli/04-cli-command-surface-decomposition-plan.md` 接管。

P01-P16 均已有 child task package/review evidence；P01-P15 有 public PR/merge evidence，P16 是 private closeout review。P15 已关闭 G-02/G-03 public code contract/gate，P16 已关闭 G-05。后续不得把 P14 的 thin-handler gate 读成 REST/WS daemon handler generation；真实 daemon runtime/codegen 必须另建任务。

## 1.1 已吸收的 GPT 审查 immediate hardening

这些项目已经从“报告建议”进入公开代码或状态矩阵；后续 packet 不应重复派同一件事，只需要继续补完整产品化：

| 报告问题 | 已吸收内容 | 仍未完成 |
| --- | --- | --- |
| `payload: unknown` 长期扩散 | application Service 增加 typed payload reader；GUI bridge 只在 transport boundary 接受 unknown；implementation contract 禁止 LocalControllerService 新增 bare unknown 参数；P02/P14 增加 API registry 与当前 bridge handler drift gate | REST/WS daemon runtime/codegen |
| Electron CSP 过宽 | 生产 CSP 去掉 wildcard localhost；dev 只允许 `127.0.0.1:5173` | browser pane / preview pane 的权限例外流程 |
| Electron IPC / permission / navigation hardening | IPC sender/frame/origin 校验；window-open deny；will-navigate guard；permission deny-by-default | browser pane / localhost preview 的 threat model 与权限例外流程 |
| Node 运行路径不自洽 | CI 扩到 Node 24/26 matrix；README 澄清 source-entry 与 `npm run check`；CI 增加 GUI renderer build job | 正式 release/package matrix 和安装分发验证 |
| Supply chain gate 缺失 | Dependabot；全量与 production-only npm audit high gate；CycloneDX SBOM validation；CI supply-chain job；P11 补 OSV evidence path、license policy、AGPL checklist、release artifact SBOM boundary | 真实 installers/artifacts 生成与发布仍 deferred |
| GitHub/Linear 占位误导 | package README 与 exported status 常量显式标注 placeholder | PLT-Adapter 最小只读 adapter 实现 |
| CLI 复杂度热点 | 已迁出 GUI 轨道，归 `../m2-5-cli/04-cli-command-surface-decomposition-plan.md` | M2.5-CLI TP-12 拆分 parser/command registry 和结构复杂度 gate |

## 2. 依赖顺序

1. TP-M2.5-08 与 TP-M2.5-12 先做，清理文档入口、派工门禁、placeholder 状态。已完成。
2. TP-M2.5-01 与 TP-M2.5-02 并行，先锁住 Service/API surface。已完成 current gate。
3. TP-M2.5-03 之后再做 TP-M2.5-04；不能先写 tmux backend 再补 registry。已完成 contract/policy。
4. TP-M2.5-05 依赖 TP-M2.5-02 的统一 API 语义。已完成 contract。
5. TP-M2.5-06 可与 backend spike 并行，但不能把 fake terminal 当作 terminal 架构完成证据。已完成 spike。
6. TP-M2.5-09 应在 browser pane / localhost preview / remote content 前完成。已完成 foundation security baseline。
7. TP-M2.5-07、TP-M2.5-10、TP-M2.5-11 可并行做 release hardening；M2.5 exit 前必须有独立设计结论。已完成 contract/gate baseline。
8. CLI parser decomposition 不在本 GUI 轨道派工；GUI worker 只消费 M2.5-CLI 稳定后的 command/service contract。

## 3. 与后续里程碑的接口

| 后续里程碑 | M2.5 必须留下的接口 |
| --- | --- |
| PLT-TaskTree task hierarchy | task workspace/session metadata 不得成为 task lifecycle owner；PLT-TaskTree 可引用 taskId 作为 workspace context，但父子任务状态仍由 relation/projection 处理 |
| PLT-Adapter external adapters | adapter Service 也必须可映射到 daemon/API；外部 snapshot 不进入 terminal/session lifecycle |
| PLT-CrossRepo cross-harness product-line | host/project/workspace identity 需要能容纳跨仓 EntityRef，但 M2.5 不实现跨仓 resolver |
| GUI-V2 GUI v2 | workspace shell、OpenTarget、daemon API、session registry 是 GUI v2 的底座；GUI-V2 不应重新发明页面型 GUI |

## 4. 明确不做

- 不做完整 GUI v2 多端聚合。
- 不做云 relay。
- 不实现账号系统。
- 不把 terminal stream 同步到中心服务器。
- 不把 task 父子关系提前塞进 terminal session lifecycle。
