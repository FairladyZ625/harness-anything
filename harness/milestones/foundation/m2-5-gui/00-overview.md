# M2.5-GUI · Daemon Productization & Hardening

- **状态**: closed-for-m2-5-contract-ready
- **日期**: 2026-06-14
- **位置**: M2.5-CLI P0/P1 稳定后、PLT-TaskTree/GUI-V2 前
- **来源**: Opus 对抗式审查、GLM 解释、2026-06-13 用户裁决、2026-06-14 M2.5 CLI/GU​​I 分轨裁决

## 阅读顺序

1. 本文件确认 M2.5 的产品化硬化边界。
2. `01-feature-breakdown.md` 把 scope 拆成可派工 packet 候选。
3. `02-status-checklist.md` 是 M2.5 的状态账本。
4. `03-review-action-matrix.md` 逐条映射 GPT/Opus 的 P0/P1/P2/P3。
5. CLI dogfood、Legacy Intake、parser 拆分、template/preset/check 接线归 `../m2-5-cli/`。
6. 正式派工仍必须继承 `../00-packet-contract-template.md`，并写入具体 `reading_list`。

## 0. 为什么有 M2.5

M1/M2 继续聚焦 kernel/application/CLI 与旧功能等价，不扩大 production daemon handler 实现范围。但 GUI/daemon 架构已经明确进入产品路线，不能等到 PLT-TaskTree/GUI-V2 才补基础合同。

M2.5-GUI 是 GUI/daemon hardening 轨道：在 M2.5-CLI 锁住 Legacy Intake、template/preset/check、CLI parser 与 gate 语义后，把 application Service surface、schema、daemon API、terminal session 和分发路线升级到能支撑 GUI/daemon 的状态。

## 1. 用户裁决

1. **统一协议、多 transport**：daemon API/WS handler contract 只有一套。local 可走 Unix domain socket / platform IPC / loopback TCP，remote 走系统 `ssh` tunnel。不得产生 local-only 或 remote-only 的第二套 API 语义。
2. **tmux/durable terminal 进入 baseline**：`direct-pty` 可用于最小 PTY 与降级；M2.5 必须完成 `tmux` 或等价 detach/resume backend 的设计与验证。
3. **Service 不可映射就重构**：不接受 CLI 和 GUI/daemon 调不同 Service surface。daemon adapter shim 不是默认兜底，除非另立 ADR。
4. **README 是知识地图**：architecture README 服务架构审查者、新 agent、任务拆分者；实现 worker 必须依赖具体 task packet 的阅读清单。
5. **产品化分发进入范围**：macOS/Windows/Linux 分发、签名、安装、升级、daemon 安装与远程 daemon bootstrap 需要单独设计。

## 2. Scope

M2.5 必须交付；截至 P01-P16，M2.5-GUI 合同层、hardening 层和 second-round review closeout 均已完成：

- daemon transport contract：local IPC/socket、loopback fallback、SSH tunnel；
- remote daemon token bootstrap 与 tunnel lifecycle；
- terminal durable backend：tmux 或等价 detach/resume backend；
- `TerminalSessionInfo` schema single-source cleanup；
- `ScrollbackConfig`、`TunnelConnectionInfo` 合同；
- Service mappability / API registry / GUI bridge handler drift gates，接入 `npm run check`；
- task packet reading-list gate；
- desktop distribution/update architecture：macOS、Windows、Linux、daemon install/update、remote daemon bootstrap；
- roadmap / ADR / SSoT / governance 回写。

GUI closeout 已关闭：

- P16 完成 P01-P15 closeout evidence 的第二轮定向 review；Opus 结论为 no open P0/P1/P2，G-05 可关闭。

仍需在 real daemon REST/WS runtime 前关闭，但不阻塞当前 M2.5 contract-ready closeout：

- Application read path 的 synchronous I/O migration 或 daemon-side async wrapper decision。

## 3. Non-Scope

- 不实现完整 GUI 产品面；V1 本地桌面客户端归 GUI-V1 里程碑（紧接本里程碑）；V2 聚合只读归 GUI-V2。
- 不做 cloud relay / browser mobile live terminal，除非另立产品决策。
- 不承诺设备重启后恢复正在运行的 terminal process。tmux 只承诺 daemon/GUI 重启后的 attach 能力，机器重启后的恢复另行设计。
- 不引入 CLI/GUI 不一致的 Service surface。
- 不处理 Legacy Intake 或 retired cutover gate replacement；这些归 M2.5-CLI。

## 4. Exit Criteria

- [x] `harness/contracts/39-daemon-api-service-contract.md` 覆盖 M2.5 新增合同主线；`EnvProfile` / named `TrustPolicy` public code contract/gate 由 P15 / PR #59 关闭。
- [x] M2.5-CLI Locks A-E 已稳定，GUI 不重新定义 legacy、task、preset、check 口径。
- [x] ADR-0004/0005 与 workspace 39 不再复制 canonical schema；P03/P04/P05 留下可测 contract。
- [x] `implementation-contract-standard.md` / product-line docs hardening 记录 service mappability、schema single-source、task reading-list gate。
- [x] 公开 check 能阻止新增长期 `payload: unknown` Service surface，并通过 P02/P14 覆盖当前 GUI bridge registry drift。
- [x] distribution/update architecture 有 typed contract entry；真实 installers、signing、notarization、auto-update deferred。
- [x] decision-log supersession 文档一致性补齐，E21-E32 已有 `Narrows:` / `Supersedes:` / `Refines:` 标记。
- [x] 第二轮定向 review 验证已回写文档是否解决第一轮 findings，不再从头扩范围。
- [x] Application synchronous read I/O 已明确记录为 daemon-runtime deferred blocker；真实 REST/WS daemon runtime 前必须关闭。
