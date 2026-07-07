# Implementation Status Matrix

- **状态**: canonical
- **日期**: 2026-06-14（2026-07-03 同步 M3 exit 与 M4 承重补全宪章；2026-07-03 同步 M4 exit）
- **来源**: GPT 深度审查报告 `deep-research-report.md`、Opus 对抗审查、M1/M2 status checklist
- **目的**: 把 architecture / roadmap / README / code 的状态差异显式化，避免后来者把 planned target 误读为 shipped implementation。

## 状态词表

| 状态 | 含义 |
| --- | --- |
| `shipped` | 已在公开代码中实现，并有测试/CI 或任务 closeout 证据 |
| `release-deferred` | 功能或证据已完成，但正式发布/分发动作延后 |
| `implemented` | 已实现当前里程碑约定的能力，但未必已经发布；必须看该行下一步是否仍有 release/defer 边界 |
| `partially-implemented` | 有真实代码路径，但尚未覆盖完整合同或产品场景 |
| `foundation-only` | 只有安全壳、包骨架、view model、schema 或占位 Service；不能宣称产品能力已实现 |
| `contract-ready` | 合同、schema、policy、checker 或 spike evidence 已可支撑后续实现；不能宣称完整 runtime/product capability 已 shipped |
| `prototyped` | 原型或 spike 已存在，但未晋升为 production implementation |
| `active-planning` | 里程碑协调或 canonical 文档门禁已 active，但公开实现包尚未开始 |
| `planned` | canonical 文档已裁决或进入 roadmap，但代码尚未实现 |
| `placeholder` | 包/目录/接口存在用于占位，必须显式标注，不能当作已实现 |
| `deprecated` | 历史实现或证据仍存在，但未来策略、主线 gate 或推荐流程不得继续依赖 |

Milestone status checklists may use narrower local states such as
`done_for_m2_5`, `done_for_current_gui_gate`, or
`contract_ready_no_daemon_runtime`. Those are scoped ledger states, not public
product claims; map them back to `contract-ready`, `foundation-only`,
`prototyped`, or `release-deferred` before writing public docs.

Milestone document headers may also use workflow states:
`active-hardening` means the milestone is in closeout/hardening, with scoped
gaps still tracked; `working-ledger` means the file is an operational ledger
for packets and findings, not a shipped-status declaration. These workflow
states must not appear as public capability status.

## 当前矩阵

| 能力 | 状态 | 文档源 | 代码/证据源 | 下一步 |
| --- | --- | --- | --- | --- |
| M1 minimal loop | `shipped` | `harness/milestones/foundation/m1-minimal-loop/02-status-checklist.md` | public PR #12-#16; `npm run check` evidence | 仅维护，不回溯扩 scope |
| M2 coding vertical | `shipped` + `release-deferred` | `harness/milestones/foundation/m2-coding-vertical/04-status-checklist.md` | public PR #17-#23; package release deferred | release/distribution milestone 再处理 npm publish |
| M3 triadic kernel | `shipped` | `harness/milestones/foundation/m3-triadic-kernel/02-status-checklist.md`; M3 主任务 ledger | public PR #100-#127；R1-R5 remediation 两层验收；PR #128 provenance 回填迁移；PR #129 task-complete 错误透出；exit 2026-07-03 | 仅维护；TP-13 删除语义泛化与后续承重补全交给 M4/后续 PLT |
| M4 load-bearing completion | `shipped` | `harness/milestones/foundation/m4-metabolism/02-status-checklist.md`; M4 宪章 `tasks/task_01KWK7XGGF9SADQKH4AQ5KT755-m4/artifacts/m4-charter-v1.md`; `ha decision list --legacy-range E63-E71 --compact` | public PR #130/#131/#133/#134/#136/#137/#138/#139；exit gate=CEO decision-ledger walk + Opus×Codex 双盲红队，2 项假绿由 remediation PR #141 修复复验；exit 2026-07-03，main `44e0640` | 仅维护；residual follow-up 已立任务（check-schema-contracts parity 断言、`harness/docmap.json` 初始内容与 manifest 缺失提示）；WP5 ref 正则启发式产品化前重审 |
| Full-cutover strategy | `deprecated` | `ha decision show E21`, `harness/contracts/24-source-inventory-and-cutover-plan.md` | M2-P7 historical evidence only | M2.5-CLI replaces future gates with Legacy Intake readiness/smoke |
| Legacy Intake | `implemented-for-m2-5` | `harness/milestones/foundation/m2-5-cli/00-overview.md`; `harness/contracts/20-legacy-maintenance-and-migration-playbook.md` | M25CLI-P03 PR #29 schema/layout; M25CLI-P04 PR #30 scan/plan/copy/index/verify; M25CLI-P05 PR #31 collision policy; M25CLI-P06 PR #32 rebuild provenance; P13/P14 replaced future full-cutover checks/docs with Legacy Intake readiness/smoke; P16 PR #62 closed remaining command/flag parity | M2.5 complete; batch convenience commands remain explicit low-priority deferrals, not M2.5 blockers |
| Coding vertical template/preset/check wiring | `implemented` | `harness/milestones/foundation/m2-5-cli/01-feature-breakdown.md`; M2.5 commander Lock C | M25CLI-P07 PR #33 bundled `software/coding` catalog; M25CLI-P08 PR #34 additive preset wiring and frontmatter metadata; M25CLI-P09 PR #38 metadata-driven check/profile validation; M25CLI-P10 PR #39 project `harness.yaml settings` defaults and configured locale check; M25CLI-P11 PR #40 user dev-mode/custom vertical authorization gate; P15/P15b rich declarative assets and script authorization; P16 command/flag parity | Lock C/D complete; GUI task creation/settings and command palette/daemon invocation can consume these semantics |
| Kernel / projection / write coordination | `shipped` | `10-foundation/02-domain-model.md`, `harness/contracts/37-write-coordination-contract.md` | `packages/kernel/src/**`, tests | 后续只做 hardening |
| Local adapter | `shipped` | `50-adapters/23-adapter-implementation-guide.md` | `packages/adapters/local/src/index.ts` | 保持 local mainline |
| Multica read-only/adopt adapter | `partially-implemented` | `50-adapters/23-adapter-implementation-guide.md` | `packages/adapters/multica/src/index.ts` | PLT-Adapter 前补完整 adapter status/readme |
| GitHub Issues adapter | `placeholder` | `50-adapters/32-github-issues-adapter-prd.md` | `packages/adapters/github-issues/src/index.ts` | PLT-Adapter 创建最小只读 task packet；当前 README/package 必须标 placeholder |
| Linear adapter | `placeholder` | `50-adapters/33-linear-adapter-prd.md` | `packages/adapters/linear/src/index.ts` | PLT-Adapter 创建最小只读 task packet；当前 README/package 必须标 placeholder |
| GUI foundation shell | `contract-ready` + `foundation-only` | `40-gui-and-apps/31-local-gui-spec.md`, `31A-electron-security-contract.md`, M2.5-GUI status checklist | `packages/gui/src/main/**`, `packages/gui/src/preload/**`, IPC sender 校验、生产 CSP 无 wildcard localhost、navigation/window-open/permission guard tests；P12 PR #57 adds preload `shipped`/`deferred` capability metadata; P14 PR #58 gates shipped GUI bridge handlers from `apiRouteContracts` | Foundation shell and current bridge gates are ready; production GUI v2/browser panes remain future capability |
| GUI workspace shell / dockable panes | `prototyped` | ADR-0003, `40-gui-and-apps/39-workspace-terminal-architecture.md` | P06 PR #49 dockable workspace shell/open target/layout persistence spike; `40-gui-and-apps/prototypes/operator-gui-v2` | Production GUI v2 remains GUI-V2; do not treat spike as shipped workspace product |
| Daemon API / Service host | `contract-ready` | `harness/contracts/39-daemon-api-service-contract.md` | P02 PR #45 API registry/schema ids/deferred GUI bridge contracts; P14 PR #58 current bridge drift gate; no `packages/daemon` runtime | Future daemon REST/WS runtime/codegen must consume the registry; M2.5 does not claim runtime shipped |
| Terminal session registry | `contract-ready` | ADR-0004, `harness/contracts/39` §5 | P03 PR #46 session registry model/tests; legacy `openShell()` is marked `deferred` in preload capabilities by P12 PR #57 | Real terminal process host remains future runtime work; legacy `openShell`不得作为 shipped terminal lifecycle |
| Durable terminal backend | `contract-ready` | ADR-0004, M2.5 overview | P04 PR #47 tmux/direct-pty/remote backend policy and downgrade semantics | Production backend implementation remains future; downgrade is explicit, not free |
| SSH tunnel / remote daemon | `contract-ready` | ADR-0005, `harness/contracts/39` §6 | P05 PR #48 remote daemon SSH tunnel/token lifecycle contract | No cloud relay or production remote daemon runtime claimed |
| Service mappability gate | `contract-ready` | `harness/contracts/39` §7, implementation standard | P01 PR #44 typed payload/bare unknown gate; P02 API registry; P14 shipped GUI bridge handler drift gate; P15 PR #59 / merge `f46ccd3` added `EnvProfile` and named `TrustPolicy` public code contracts/gates | REST/WS daemon runtime/codegen remains future; future daemon routes consuming `EnvProfile`/`TrustPolicy` must bind them into API/schema registry |
| CLI lifecycle shared-service debt | `partially-implemented` | P13 review; `harness/milestones/foundation/m2-5-gui/reviews/m2-5-architecture-review.md` reconciliation table | Five existing CLI adapter-debt files are explicitly allowlisted in `tools/check-import-boundaries.mjs`: `adopt.ts`, `git-diff.ts`, `legacy-rebuild.ts`, `lifecycle.ts`, and `preset-task.ts`. Checker is wired into `npm run check` / `check:pr`; terminal status guard has CLI test coverage. | Debt is bounded but real. Do not claim full CLI/GUI/daemon shared Application Service path until lifecycle/status writes leave the CLI adapter-debt allowlist; until then `makeLocalControllerService.setTaskStatus` and CLI `runStatusSet` terminal guards must stay semantically aligned. |
| Runtime / package / CI reproducibility | `contract-ready` | README, CI workflow, M2.5-GUI P10 | P10 PR #54 runtime/release readiness contract, source-run doctor smoke, Node 24/26 matrix, package smoke, GUI renderer build CI, release overclaim checks | Formal installer/release artifact validation remains future release/distribution work |
| Supply chain / SBOM / SCA | `release-deferred` | distribution/update roadmap；M2.5 TP-M2.5-11 | P11 PR #55；`harness:check-supply-chain` 跑全量与 production-only npm audit high gate、CycloneDX SBOM validation、OSV evidence path、license policy、Dependabot entry binding、AGPL checklist、release artifact SBOM boundary；CI 独立 supply-chain job | 真实 installers、signed artifacts、notarization、release feeds、npm publication 仍归后续 release/distribution milestone |
| GPT/Opus review action matrix | `closed-for-m2-5-gui` | `harness/milestones/foundation/m2-5-gui/03-review-action-matrix.md` | P0/P1/P2/P3 已有 ledger；P01-P16 evidence 已回写；architecture review reconciliation 已标注 stale/resolved items；G-02/G-03 closed by P15；G-05 closed by P16 second-round directed review | Future daemon runtime must close Application sync I/O before REST/WS exposure |
| Architecture review residuals | `partially-implemented` | `harness/milestones/foundation/m2-5-gui/reviews/m2-5-architecture-review.md` reconciliation table | P13 closed Application composition and import-boundary gaps; E12 closed WriteCoordinator port classification; E21-E32 close M2.5 supersession markers; P12/P14 closed `archiveTask`/`openShell` bridge status; P1-B remains explicitly tracked | Before real REST/WS daemon runtime, close Application async read path |
| CLI command parser complexity | `implemented` | `harness/milestones/foundation/m2-5-cli/04-cli-command-surface-decomposition-plan.md` | M25CLI-P12 PR #41 split parser/command registry and added structure/complexity gates; P16 added command/flag parity without reopening parser monolith | Maintain gates; no new CLI command should bypass parser/registry structure |
| GUI-V1 V1 local desktop GUI | `planned` | `harness/milestones/gui/gui-v1-local-remote/00-overview.md`, `40-gui-and-apps/40-gui-v1-prerequisites.md` | GUI foundation shell (`packages/gui/src/main/**`) contract-ready; no daemon runtime; no production Electron views | M2.5-GUI 验收后启动 Phase 0；与 PLT-TaskTree/PLT-Adapter 可技术并行；4 个 PRE 前置条件未关闭 |
| PLT-TaskTree task hierarchy | `planned` | `harness/milestones/platform/plt-task-tree/00-overview.md` | 未实现 | M2.5 后开工；workspace task metadata 不得成为 lifecycle owner |
| PLT-Adapter external adapters | `planned` | `harness/milestones/platform/plt-adapter/00-overview.md` | GitHub/Linear placeholder | PLT-Adapter 前先清 adapter status |
| PLT-CrossRepo cross-harness product-line | `planned` | ADR-0002, `harness/milestones/platform/plt-cross-repo/00-overview.md` | 未实现 | PLT-TaskTree/PLT-Adapter 后推进 |
| GUI-V2 GUI v2 aggregation (V2 only) | `planned` | `harness/milestones/gui/gui-v2-aggregation/00-overview.md` | GUI foundation only; V1 已剥离至 GUI-V1 | 入口条件为 GUI-V1+PLT-Adapter+PLT-CrossRepo；不在 M2.5 宣称 GUI v2 complete |

## 维护规则

- 新增 architecture claim 时，必须在本矩阵新增或更新一行。
- 从 `planned` 晋升为 `partially-implemented` 或 `shipped` 时，必须写明代码/测试/CI evidence。
- Package README 不得比本矩阵更乐观。
- Task packet 创建时必须引用相关矩阵行，明确本包要改变哪一项状态。
