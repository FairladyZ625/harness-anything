# M1 · 状态清单

- **状态**: completed
- **日期**: 2026-06-12

> 2026-06-14 修订：本清单中的 later cutover wording 是 M1 当时的历史方向。未来不再追求 retired cutover，改由 M2.5-CLI Legacy Intake + forward-only dogfood 接管。
- **核对来源**: public repo `harness-anything` main through PR #16; private module tasks M1-01, M1-02, M1-03, final closeout task, and Claude tmux double check.
- **口径**: 本清单按 M1 `01-feature-breakdown.md` 逐项给最终处置。`[x]` 表示该条对 M1 exit 已有最终处置：要么实现/文档/测试完成，要么已由 M1 decision/addendum 明确改口径并移出 M1 阻塞面。Formal npm release、GUI/Dashboard、M2 closeout/publishNote、cross-harness EntityRef resolver、external engine writeback 不属于 M1 exit。

## 总览

| 分组 | M1 exit 处置 | 证据 |
| --- | --- | --- |
| G1 Supersession ADR | completed | KR baseline boundary docs; M1 public/private boundary and roadmap decisions |
| G2 kernel 包骨架与 import 边界 | completed | PR #12, #13, #14; `npm run check`; import/private/package/cutover gates |
| G3 WriteCoordinator + ArtifactStore | completed | PR #12 and #14; watermark real projection hash; journal compaction V1 tests |
| G4 LocalLifecycleEngine + CLI 核心命令 | completed | PR #12 and #13; lifecycle command tests; EntityRef contract docs |
| G5 SQLite 投影 + check + governance | completed | PR #13 and #14; `harness-check-report/v1`; post-merge collaboration gate |
| G6 包管理、发布与公开文档 | completed for M1 exit; release items deferred | local package smoke, docs-release, minimal example; formal npm release deferred |
| G7 Dogfood 验证 | completed | M1-03 dogfood transcript and final closeout material readiness check |

## Evidence Index

| ID | Type | Evidence |
| --- | --- | --- |
| E-M1-01 | public PR | PR #12 merged as `80b9c0f651161c0f8e573b05bef1b8f91e4688be` |
| E-M1-02 | public PR | PR #13 merged as `a7a9a6479c3f08b8db796f7eb99ee0fd3495680a` |
| E-M1-03 | public PR | PR #14 merged as `aea3ee07f75ea620e08fbca9d72f1f404f5180ea` |
| E-M1-15 | public PR | PR #15 merged as `ac7af489bf0a3116950ce7f951b8f216645525e2`, fixing local `.worktrees/**/harness/**` cutover scan pollution |
| E-M1-16 | public PR | PR #16 merged as `c621620`, adding public `CONTRIBUTING.md` for M1 contribution and boundary expectations |
| E-MAT | private check | `task-list --module m1-minimal-loop` reports `materialsReady=true` for M1-01, M1-02, M1-03, and final closeout task |
| E-DOGFOOD | private artifact | `planning/modules/m1-minimal-loop/tasks/2026-06-12-m1-03-exit-readiness-dogfood-6dvnoo/artifacts/dogfood-transcript.md` |
| E-CHECK | public verification | GitHub checks passed for PR #12, #13, #14, #15, and #16; local public `npm run check` passed on main `c621620` |
| E-CLAUDE | external review | Claude tmux review verdict: PASS; no P0/P1/P2 after PR #16; remaining P3 only `lastCommittedOpIds` future cleanup after coordinator fixed module-plan drift |

## G1 · Supersession ADR 与基线定稿

| Done | 功能点 | M1 final disposition | Evidence |
| --- | --- | --- | --- |
| [x] | G1-F1 rewrite-baseline ADR 撰写与评审 | completed | KR baseline docs and M1 boundary addenda freeze old runtime as superseded/lesson-only for this rewrite path. |
| [x] | G1-F2 旧代码/旧文档定性说明 | completed | Public/private boundary and M1 docs distinguish source package, generated cache, private harness, and old runtime evidence. |

## G2 · kernel 包骨架与 import 边界

| Done | 功能点 | M1 final disposition | Evidence |
| --- | --- | --- | --- |
| [x] | G2-F1 monorepo 包结构搭建 | completed | `packages/kernel`, `packages/cli`, adapters, application, gui package skeleton. |
| [x] | G2-F2 domain 零外部依赖 import 边界测试 | completed | import boundary and legacy import gates in `npm run check`. |
| [x] | G2-F3 类型层边界守卫 | completed | implementation contract gates and typecheck. |
| [x] | G2-F4 no-ts-nocheck gate | completed | forbidden symbol scan in public check. |
| [x] | G2-F5 historical retirement gates | completed for M1 exit | retired cutover-readiness gate existed for M1/M2 evidence; future final clean cutover is retired and replaced by M2.5-CLI Legacy Intake. |
| [x] | G2-F6 `npm run check` 脚本 + built test runner | completed | public CI and local targeted check evidence. |
| [x] | G2-F7 application Service 可映射性约束 | completed for M1 exit; M2.5 gate pending | `harness/contracts/39-daemon-api-service-contract.md` 已新增；M1/M2 已完成不回溯阻塞，M2.5 起新增/修改 Service 的 task_plan 必须说明 typed/mappable 与 `payload: unknown` 债务。 |

## G3 · WriteCoordinator + ArtifactStore

| Done | 功能点 | M1 final disposition | Evidence |
| --- | --- | --- | --- |
| [x] | G3-F1 JSONL Journal | completed | Write journal coordinator and tests. |
| [x] | G3-F2 全局 committer 锁 + per-task 锁 | completed | global/per-task lock tests. |
| [x] | G3-F3 崩溃恢复 + 幂等机制 | completed | crash/replay/idempotency tests. |
| [x] | G3-F4 WriteWatermark 控制记录 | completed | PR #14 records real projection hash rather than stub-only hash. |
| [x] | G3-F5 journal 压缩 | completed | PR #14 compaction V1 only removes watermark-covered records and is non-fatal on failure. |
| [x] | G3-F6 ArtifactStore markdown 后端 | completed | markdown artifact store and writer tests. |
| [x] | G3-F7 package create / package archive 操作 | completed | create/archive command path and task archive tests. |
| [x] | G3-F8 LifecycleBinding 不可变强制 | completed | binding immutability and `binding_tampered` check shape. |
| [x] | G3-F9 同 task FIFO 顺序保证 | completed | same-task FIFO tests. |
| [x] | G3-F10 HarnessTransaction/allowed paths | completed | allowed path and implementation contract gates. |

## G4 · LocalLifecycleEngine + CLI 核心命令

| Done | 功能点 | M1 final disposition | Evidence |
| --- | --- | --- | --- |
| [x] | G4-F1 LocalLifecycleEngine + local snapshot | completed | local adapter and status tests. |
| [x] | G4-F2 local 状态所有权护栏 | completed | local ownership guard tests. |
| [x] | G4-F3 `harness init` + manifest schema | completed | PR #12 init flow and minimal-project smoke. |
| [x] | G4-F4 `harness new-task` | completed | random task identity and local task package tests. |
| [x] | G4-F5 `harness task status set` | completed | six-state domain validation. |
| [x] | G4-F6 `harness task progress append` | completed | task-log/progress append path. |
| [x] | G4-F7 `harness task archive` | completed | PR #13 archive command and lifecycle tests. |
| [x] | G4-F8 `harness task list` | completed | SQLite projection backed list. |
| [x] | G4-F9 `harness task supersede` | completed | PR #13 supersede command and relation checks. |
| [x] | G4-F10 `harness task delete --soft\|--hard` | completed | PR #13 delete command with M1/ND-2 hard-delete guard. |
| [x] | G4-F11 `harness task reopen` | completed | PR #13 reopen command with M1/ND-1 terminal guard. |
| [x] | G4-F12 `harness status --json` | completed | PR #13/14 JSON status report envelope. |
| [x] | G4-F13 Skill 初版 | completed | docs-release harness agent skill. |
| [x] | G4-F14 command registry + result envelope | completed for M1 exit | command result envelope and registry enough for M1 command surface; deeper registry hardening can continue later. |
| [x] | G4-F15 GitRunner / git status summary | completed | git status summary/write coordinator evidence. |
| [x] | G4-F16 task repository / scanner | completed | scanner and projection rebuild evidence. |
| [x] | G4-F17 EntityRef 语法定稿写入 domain docs | completed | EntityRef syntax, M1 local/prefixed storage, and PLT-CrossRepo resolver deferral documented. |

## G5 · SQLite 投影 + check + governance rebuild

| Done | 功能点 | M1 final disposition | Evidence |
| --- | --- | --- | --- |
| [x] | G5-F1 SQLite 投影构建器 | completed | projection builder and rebuild tests. |
| [x] | G5-F2 `lifecycleStatus` 投影（三轴联合） | completed | coordination/package/closeout projection rows. |
| [x] | G5-F3 watermark 正确推进检查 | completed | PR #14 deterministic real projection hash test. |
| [x] | G5-F4 `harness check` 三轴联合输出 | completed | `harness-check-report/v1` schema, fixtures, and CLI report output. |
| [x] | G5-F5 source package boundary + post-merge gate | completed | post-merge gate covers duplicate IDs, duplicate external bindings, generated tracked files, binding tamper, conflict markers, dangling EntityRefs, and relation cycles. |
| [x] | G5-F6 package surface check | completed for M1 exit; formal release deferred | package policy intentionally keeps package private/0.0.0 during M1; formal package surface for publish moves to release milestone. |
| [x] | G5-F7 `governance rebuild` 命令 | completed | explicit rebuild command boundary decided by ND-3 and command path exists. |
| [x] | G5-F8 binding 篡改检测 checker | completed | `binding_tampered` check/report shape. |

## G6 · 包管理、发布与公开文档

| Done | 功能点 | M1 final disposition | Evidence |
| --- | --- | --- | --- |
| [x] | G6-F1 npm package distribution + bin.harness | completed for M1 exit; formal release deferred | local package smoke completed; public package remains private/0.0.0 by policy until release milestone. |
| [x] | G6-F2 `build:runtime` / `prepack` / `prepublishOnly` | completed for M1 exit; formal release deferred | M1 requires local smoke/package policy, not npm publish hooks. |
| [x] | G6-F3 postpublish smoke | completed for M1 exit; formal release deferred | local install/smoke path covers M1; postpublish pipeline belongs to release milestone. |
| [x] | G6-F4 license 文件 | completed | AGPL license files present. |
| [x] | G6-F5 CHANGELOG + 中英双语 README | completed for M1 exit | README quick-start surface exists; release-grade changelog/bilingual polish can continue outside M1. |
| [x] | G6-F6 task state machine guide | completed | docs-release M1 guide. |
| [x] | G6-F7 repository operating models guide | completed | docs-release M1 repository model. |
| [x] | G6-F8 document audience and surfaces guide | completed | public/private boundary and docs-release guide. |
| [x] | G6-F9 contributing guide | completed | Public `CONTRIBUTING.md` exists after PR #16 and documents contribution flow, public/private boundary, review expectations, and release/Dashboard exclusions. |
| [x] | G6-F10 docs-release architecture overview | completed | docs-release architecture overview. |
| [x] | G6-F11 minimal-project example | completed | `examples/minimal-project` and CLI smoke. |

## G7 · Dogfood 验证

| Done | 功能点 | M1 final disposition | Evidence |
| --- | --- | --- | --- |
| [x] | G7-F1 至少一个真实任务包用新 harness 协调完成 | completed for M1 exit | M1-03 dogfood task transcript records `init -> new-task -> status -> task list -> check --post-merge`; projection row has `coordinationStatus=open`, `packageDisposition=active`, `closeoutReadiness=not_required`, and zero warnings. The older feature-breakdown phrase `coordinationStatus=done` is superseded by the implemented M1 domain vocabulary (`open/blocked/in_review/terminal/unknown`). |

## Decisions Closed

| Decision | Final M1 disposition |
| --- | --- |
| ND-1 `task reopen` terminal semantics | decided 2026-06-12: done/cancelled remain terminal; continuing work uses supersede. |
| ND-2 `task delete --hard` archived package behavior | decided 2026-06-12: archived/terminal/related packages cannot be hard-deleted. |
| ND-3 `governance rebuild` vs `check` boundary | decided 2026-06-12: `check` is read-oriented validation; `governance rebuild` is explicit repair/rebuild. |

## M2+ Queue

- M2: closeout/publish pipeline and publishNote.
- M2: coding vertical and preset contracts.
- PLT-TaskTree: task hierarchy, self-submitted review loop, runtime verification loop.
- PLT-TaskTree/PLT-Adapter cleanup candidate: bound or epoch-reset WriteWatermark `lastCommittedOpIds`; Claude marked current unbounded growth as P3 non-blocking for M1.
- PLT-CrossRepo: cross-harness EntityRef resolver.
- GUI-V2: GUI v2 and `harness gui` consolidation.
- Release milestone: formal npm publish, `harness` bin alias, postpublish smoke, release-grade CHANGELOG/CONTRIBUTING/bilingual docs polish.
