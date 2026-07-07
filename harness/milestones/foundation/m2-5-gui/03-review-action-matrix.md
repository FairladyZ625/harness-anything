# M2.5 · GPT/Opus Review Action Matrix

- **状态**: canonical review-ledger-closed-for-m2-5-gui
- **日期**: 2026-06-14
- **目的**: 把 GPT 深度审查和 Opus 对抗审查的 P0/P1/P2/P3 建议逐项落到代码、文档、packet 或明确延期，避免“报告读了但没接住”。

## 1. GPT 深度审查建议

| 来源优先级 | Finding | 当前处置 | 状态 | 目标文件/Packet | 验收口径 |
| --- | --- | --- | --- | --- | --- |
| P0 | daemon / terminal / session registry 文档领先实现 | P02/P03/P04/P05/P14 已补 API registry、session registry、backend policy、SSH tunnel contract、current bridge handler drift gate；仍不宣称 production daemon REST/WS runtime shipped | done_for_m2_5_contract | TP-M2.5-02/03/04/05/14, `harness/contracts/39` | Contract/gate evidence exists; real daemon runtime/codegen must be separate future task |
| P0 | GUI/daemon Service 从 `payload: unknown` 迁移到 typed/schema contract | typed payload reader + bare unknown gate + API registry + shipped GUI bridge handler drift gate 已完成；REST/WS runtime codegen 未做 | done_for_current_gui_gate | TP-M2.5-01/02/14 | 新增 public Service 必须有 schema / typed IO；current GUI bridge drift check 能失败 |
| P0 | GitHub/Linear adapter 状态不清 | package README/status 常量已标 placeholder；P12 补 GUI preload deferred capability gate | done_for_m2_5_clarity | TP-M2.5-12, PLT-Adapter packets | PLT-Adapter 前实现最小只读 adapter 或继续显式 placeholder；不得把 placeholder adapter 当 shipped |
| P1 | Electron IPC sender 校验 | P09 已补 trusted renderer URL + owned `webContents.id` gate，且生产 dev-origin trust 需要显式 dev flag | done_for_m2_5 | TP-M2.5-09 | browser pane/remote content 仍必须复用该 gate，不得绕过 |
| P1 | permission/navigation/window-open hardening | 已补 deny-by-default、will-navigate、window-open deny | done_for_foundation | TP-M2.5-09 | 未来例外必须走 threat model 和测试 |
| P1 | Node 24/26 CI 与运行路径标准化 | P10 已补 runtime/release readiness contract、source-run doctor smoke、Node 24/26 matrix、README/docs、package smoke、GUI build CI 和 drift checker | done_for_m2_5 | TP-M2.5-10 | 后续真实 installer/release artifact 任务必须扩展该 contract，而不是另起 prose-only release notes |
| P1 | CLI 高复杂度热点：`parseArgs` / `runExtensionCommand` | 已迁出 GUI 轨道，归 M2.5-CLI | moved | `../m2-5-cli/04-cli-command-surface-decomposition-plan.md` | parser 拆为 domain parsers；新增 function-level complexity gate |
| P1 | 外层旧主干复杂度：preset/migration/dashboard | M2.5 不扩大到旧主干重构；需独立 legacy debt packet | deferred | legacy debt roadmap | 不阻塞内层 clean rewrite，但不得迁入内层 |
| P2 | 文档状态矩阵 | P08/P12/P13/P14 closeout 后继续回写 status checklist、implementation matrix、architecture review reconciliation；自动生成仍非 M2.5 exit 条件 | done_for_m2_5 | TP-M2.5-08 + closeout docs | 后续可另建 governance automation；当前不得再保留 stale blocker |
| P2 | OSV/Dependabot/SBOM | P11 已补 Dependabot entry binding、npm audit/prod audit、CycloneDX SBOM、OSV evidence path、license policy、AGPL checklist、release artifact SBOM boundary | done_for_m2_5 | TP-M2.5-11 / PR #55 | 后续 release/distribution 任务生成真实 artifact 时必须复用该 gate，不得 prose-only |
| P2 | GUI 模块局部测试 | GUI security/bridge/window/runtime/distribution/supply-chain/session/remote contracts 均有 focused tests；browser/preview shipped capability 未来另补 | done_for_m2_5_foundation | TP-M2.5-03/05/07/09/10/11/14 | browser pane 和 workspace shell 产品化时补独立 tests |
| P3 | placeholder/dormant code 标注 | GitHub/Linear 已标；P12 PR #57 将 `archiveTask`/legacy `openShell` 标成 deferred preload capabilities 并由 API registry gate 检查 | done_for_m2_5 | TP-M2.5-12 | 后续 UI/handler generation 必须消费 `deferred`，不得当 shipped |

## 2. Opus 对抗审查建议

| 编号 | Finding | 当前处置 | 状态 | 下一步 |
| --- | --- | --- | --- | --- |
| O1 | 生产 CSP 不应允许 `127.0.0.1:*` | 已改为生产 `connect-src 'self'`，dev 只允许 `:5173` | closed | browser pane 例外需 threat model |
| O2 | CI 应跑 GUI build | 已加 Node 24/26 `gui-build` job | closed | 正式 packaging 时补 Electron main/preload bundle |
| O3 | mappability lint 不应只写 roadmap | 已加 LocalControllerService bare unknown gate | closed_for_baseline | TP-M2.5-01 补 schema registry |
| O4 | allowlist shipped/placeholder 区分 | P12 PR #57 已补 `preloadApiCapabilities`、deferred reason、allowlist/capability parity 和 active/deferred gate | closed | TP-M2.5-12 |
| O5 | Dependabot GUI workspace coverage | 已加 `/packages/gui` entry | closed | 若 GitHub 实测不覆盖再调整 |
| O6 | function-level complexity gate | 尚未实现；归 M2.5-CLI | moved | M2.5-CLI TP-12 |
| O7 | IPC sender 升级到 webContents.id | P09 已实现 owned `webContents.id` gate，future browser/preview content still fail-closed | closed_for_m2_5 | TP-M2.5-09 |
| O8 | production-only audit | P11 保留 production-only audit，并补 OSV evidence path、license/SBOM release gate | closed | 真实 release artifact 生成归后续 release/distribution |

## 2.5 全局架构设计审查 (2026-06-14 Agent Review Findings)

这些发现来源于对 M2.5 阶段设计包的深度架构扫描。

| 优先级 | Finding | 当前处置 | 状态 | 目标文件/Packet | 下一步 |
| --- | --- | --- | --- | --- | --- |
| Critical | F1: `38-publish-note-safety-contract.md` 空白 | 严重缺失发布安全契约；该项必须在 PLT-Adapter (外部 Adapter) 开发前补齐 | deferred_to_m4_prerequisite | `harness/contracts/38` | PLT-Adapter 启动前必须签署 38 规则集（正则、幂等格式） |
| High | F2: GUI-V2 严重范围过载 (Scope Overload) | 已通过 `m6-split-strategy-review.md` 拆分出 `GUI-V1` 独立里程碑 | closed | `harness/milestones/gui/gui-v1-local-remote/` | GUI-V1 里程碑已建立并落位 |
| High | F3: WriteCoordinator 仅支持单机锁机制 | 远程 Daemon/SSH tunnel 场景下可能有并行写风险 | deferred | `harness/contracts/37` | 在 GUI-V2 远程工作流开发前需明确并发策略，或在文档中加警告 |
| High | F4: Daemon API 契约 (Doc 39) 职责过载 | 单一文件承载过多子系统架构 | deferred_to_m_gui_v1 | `harness/contracts/39` | 在 GUI-V1 Phase 1 (Daemon Runtime) 开发时择机拆分 |
| Medium | F7: GUI 渲染器的状态管理真空 | 已转化为 `GUI-V1` Phase 0 的 `PRE-02` 前置条件卡点 | closed_for_m2_5 | `40-gui-and-apps/40-gui-v1-prerequisites.md` | 在 GUI 开发前签署 React 状态管理选型 ADR |

## 3. 解释：为什么不是所有项都应在当前 commit 直接做完

- daemon、terminal、tmux、SSH tunnel 是产品能力，不是小 hardening；必须进入 M2.5 task packet 并带实验记录。
- `parseArgs` 拆分会触碰 CLI JSON contract，需要 fixture-driven 回归，不能在 GUI/security hotfix 里顺手大改。
- webContents.id gate 与 placeholder allowlist 依赖 workspace/browser pane 的拥有关系；在 browser pane 前完成即可。
- OSV/license/release artifact 属 release gate，当前已补本地 npm audit/SBOM 基线，但 M2.5 exit 前不能漏。

## 4. M2.5 Exit 不可跳过项

- P0/P1 planned 行必须全部有 task closeout 或明确 ADR 改判；当前 GUI closeout gaps 已由 `02-status-checklist.md` 关闭。
- `03-review-action-matrix.md` 中所有 open 行必须在 M2.5 status checklist 中有对应 packet、gap 或 ADR defer。
- 不允许以“已文档化”为 M2.5 exit 证据；必须有代码、测试、实验报告或 ADR 改判。
