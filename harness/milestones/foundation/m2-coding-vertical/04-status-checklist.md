# M2 · 状态清单

- **状态**: completed-with-release-deferred
- **日期**: 2026-06-13
- **入口条件**: M1 exit 后才可正式计入 M2 完成度
- **口径**: M1 已完成并通过 PR #12-#16 / M1 status checklist 记录。当前仓库中已经出现的 publish/adapters/template/preset 代码只能记为 ahead-of-schedule evidence；在 M2 task packet 未创建前，不计为 M2 完成。

> 2026-06-14 修订：本清单中的 `retired cutover` / `migrate-verify retired cutover flag` 是 M2-P7 历史完成证据，不再作为未来产品策略、M2.5 exit gate 或 dogfood 前提。后续由 M2.5-CLI 的 Legacy Intake + forward-only dogfood 取代。

## 里程碑状态

| 项 | 状态 | 证据/说明 |
| --- | --- | --- |
| M2 入口 | complete | M1 已 exit；M2 Commander packet created；M2-P1..M2-P7 全部通过 public PR merge、review、PR CI、post-merge CI and private closeout evidence |
| 功能拆解 | done | `01-feature-breakdown-task-lifecycle.md`, `02-feature-breakdown-vertical-preset.md`, `03-feature-breakdown-migration-cutover.md` 已存在 |
| task packet | complete | Commander packet and M2-P1..M2-P7 child packets created；M2-P1..M2-P7 completed/merged |
| parity 绿列覆盖 | audited-2026-06-14 | parity matrix 已有；2026-06-14 完成逐行审计，见 `harness/legacy/tasks/2026-06-14-m2-5-commander-cli-gui-program/references/m25-cli-template-preset-gap/` (F-001/F-002/F-003)。审计发现 M2 §9 bundled presets 实际只交付 skeleton、M2 §11 module-parallel 被 PLT-TaskTree T6 supersede、命令/flag 层存在 parity drift。所有缺口已归档，归 M2.5-CLI P15/P16 remediation。 |
| historical cutover evidence | complete-deprecated-for-future-strategy | M2-P7 PR #23 merged as `b72ce93ad39bd71043183cdafbd6f4dd55608f6c`; `migrate-verify retired cutover flag`, retired cutover-readiness, package policy, PR CI `27460441811`, and post-merge CI `27460507765` passed as historical evidence; npm publish remains deferred; future route is M2.5-CLI Legacy Intake |

## Task Packet 级别清单

| 勾选 | Packet | 状态 | 说明 |
| --- | --- | --- | --- |
| [x] | P0 task lifecycle vertical 模板与 review/closeout 基础 | done-for-m2-p1 | M2-P1 task package `2026-06-13-m2-p1-task-lifecycle-review-closeout`; public PR #17 merged as `4362e5a0a7905d7f4c3e91db3e3b424a09cf89b1`; CI run `27455588171` green; reviewer P0/P1/P2 none |
| [x] | P1 adopt + Multica 只读 | done-for-m2-p4 | Implemented and merged in PR #20 as `27b8918fb94dd25725b629fd73c1dd9734b92397`; local checks, Opus review, PR CI `27458058622`, and post-merge CI `27458172987` green |
| [x] | P2 迁移命令基础层 | done-for-m2-p4 | PR #20 includes `migrate-plan`, `migrate-structure --plan|--apply`, `migrate-run`, and normal `migrate-verify`; retired cutover remains M2-P7 |
| [x] | P3 Check/CI 验证器集 | done-for-m2-p3 | M2-P3 PR #19 merged as `b162083dd89453ff4b9863b05e3f9da991df15d6`; check/governance/lesson profiles and repo-wide file complexity / structural decomposition gate complete; CI run `27457123872` green; Opus reviewer no P0/P1/P2 |
| [x] | P4 迁移验收与安全接入 | done-for-m2-p4 | Public PR #20 implements normal `migrate-verify`, safe-adoption, source-pack/digest evidence; excludes `retired cutover flag` to M2-P7; merged as `27b8918`; post-merge CI green |
| [x] | P5 createdBy / Git Diff evidence | done-for-m2-p5 | M2-P5 PR #21 merged as `abb293e0687d96ffa0034609aadbbe17735d482f`; local checks, Opus review, PR CI `27458762244`, and post-merge CI `27458894340` green |
| [x] | P6 Agent 辅助迁移 + 文档 | done-for-m2-p6 | M2-P6 PR #22 merged as `27daf433de270263daee9a874f30907e313ba897`; local checks, Opus review, PR CI `27459342795`, and post-merge CI `27459377573` green |
| [x] | P7 发布 + Cutover | done-for-m2-p7-historical | M2-P7 PR #23 merged as `b72ce93ad39bd71043183cdafbd6f4dd55608f6c`; package release decision remains no-publish/private/0.0.0; PR CI `27460441811` and post-merge CI `27460507765` green; future retired cutover strategy retired by 2026-06-14 decision |
| [x] | Service/API 可映射性 | completed for M2 exit; M2.5 gate pending | M2 已完成不回溯阻塞；`harness/contracts/39-daemon-api-service-contract.md` 成为 M2.5 后续 GUI/daemon/API 工作的 Service mappability gate，新增 task、review、closeout、preset Service 必须说明 typed/mappable 且不得扩大 `payload: unknown` 债务。 |

## create Task 前置检查

- [x] M1 已 exit，M2 入口条件满足。
- [x] M2 `#6/#10/#11/#14` 已裁决或 defer：#6 rejected kernel Lite/Full；#10 Git Diff Adapter 进入 M2 且限定为本地只读 evidence helper；#11 `createdBy` 进入 optional task frontmatter 审计元数据；#14 defer 到后续优化/研究任务。
- [x] M2 需要先把已有提前实现按 packet ownership 分类，避免把 prototype 当成完成项；已有代码只能作为 Reference/Artifact，不得直接算 M2 done。
- [x] 旧 binding lookup 端口已并入 `ArtifactStore.findBindingByExternalRef`；M2/PLT-Adapter 派工口径已同步，历史裁决记录保留原名上下文。

## Packet Evidence Updates

| Date | Packet | Evidence | Result |
| --- | --- | --- | --- |
| 2026-06-13 | M2-P1 | PR #17, merge `4362e5a0a7905d7f4c3e91db3e3b424a09cf89b1`, GitHub Actions `27455588171`, tmux reviewer `m2-claude-loop` | task lifecycle/review/closeout/phase gate interface lock completed; no open P0/P1/P2 |
| 2026-06-13 | M2-P2 | PR #18, merge `14f39d41ff64140428d8030a648a01e7b67ccfe9`, GitHub Actions `27456118234`, tmux reviewer `m2-claude-loop` | preset/module local runtime completed for TP-V1..TP-V5; no kernel Lite/Full; no open P0/P1/P2; non-blocking P3 residuals recorded in task review |
| 2026-06-13 | M2-P3 | PR #19, merge `b162083dd89453ff4b9863b05e3f9da991df15d6`, GitHub Actions `27457123872`, tmux reviewer `m2-claude-loop` | check/governance/lesson profiles and repo-wide file complexity / structural decomposition gate completed; no open P0/P1/P2 |
| 2026-06-13 | M2-P4 | task package `2026-06-13-m2-p4-migration-adopt`, public PR #20, merge `27b8918fb94dd25725b629fd73c1dd9734b92397`, GitHub Actions `27458058622` and `27458172987`, local `npm run check` green | migration/adopt CLI implementation completed; no open P0/P1/P2; retired cutover remains M2-P7 |
| 2026-06-13 | M2-P5 | task package `2026-06-13-m2-p5-attribution-diff-evidence`, public PR #21, merge `abb293e0687d96ffa0034609aadbbe17735d482f`, GitHub Actions `27458762244` and `27458894340`, tmux reviewer `m2-claude-loop` | createdBy/Git Diff evidence completed; no open P0/P1/P2; P6 install/docs/playbooks remains next |
| 2026-06-13 | M2-P6 | task package `2026-06-13-m2-p6-install-docs-playbooks`, public PR #22, merge `27daf433de270263daee9a874f30907e313ba897`, GitHub Actions `27459342795` and `27459377573`, tmux reviewer `m2-claude-loop` | install/doctor/docs/playbooks completed; no open P0/P1/P2; P7 retired cutover remains next |
| 2026-06-13 | M2-P7 | task package `2026-06-13-m2-p7-final-cutover-exit`, public PR #23, merge `b72ce93ad39bd71043183cdafbd6f4dd55608f6c`, GitHub Actions `27460441811` and `27460507765`, tmux reviewer `m2-claude-loop` | retired cutover evidence completed as historical M2 evidence; `migrate-verify retired cutover flag` retired for future strategy on 2026-06-14; package release deferred; no open P0/P1/P2 |

## 派工裁决摘要（2026-06-13）

| 事项 | 裁决 | Task packet 影响 |
| --- | --- | --- |
| Document Contract Lite/Full | reject kernel-level Lite/Full；模板差异放在 preset/profile/template variant | preset/schema packet 只做 profile/template 裁剪，不新增 kernel contract profile |
| 原型代码归属 | 只作 Reference/Artifact；不得直接标 done | 每个 packet 必须重新声明 gates/tests，引用原型证据但重新验收 |
| Task creator attribution | 加 optional `createdBy`，默认来自 Git user.name/user.email | task-frontmatter schema、new-task 写入、projection/report 补测试 |
| Public Git Diff Adapter | 进入 M2；本地只读 evidence helper/adapter | Check/CI 或 migration packet 可实现 JSON diff evidence report |
| Context efficiency / 200K | defer；M2 只做输入裁剪 | packet Inputs / Recommended References 必须保持裁剪 |
