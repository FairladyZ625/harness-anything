# PLT-Adapter · 状态清单

- **状态**: working-ledger
- **日期**: 2026-06-12
- **入口条件**: M2 exit 后才可正式计入 PLT-Adapter 完成度
- **口径**: 当前 Multica/GitHub/Linear package scaffold 属提前实现/预研；PLT-Adapter 正式完成必须满足 adapter PRD、fixture、stale、imported_snapshot 与只读边界验收。

## 里程碑状态

| 项 | 状态 | 证据/说明 |
| --- | --- | --- |
| PLT-Adapter 入口 | blocked | M2 未 exit |
| 功能拆解 | done | `01-feature-breakdown.md` 已定义 F-01~F-10 与 PA/PB/PC |
| task packet | not_started | 尚未创建 PLT-Adapter packets |
| Multica adapter | partial | `packages/adapters/multica` 有 readonly adopt 测试；PLT-Adapter 关系映射、stale 三态、golden fixture 未完整 |
| GitHub adapter | not_counted_as_implementation | package scaffold 存在，但未见 PRD 验收实现 |
| Linear adapter | not_counted_as_implementation | package scaffold 存在，但未见 PRD 验收实现 |
| imported_snapshot | not_started | 未见 Relation/provenance 存储和负测试 |

## Packet 级别清单

| 勾选 | Packet | 状态 | 说明 |
| --- | --- | --- | --- |
| [ ] | P0 imported_snapshot schema + Relation Mapping + binding lookup | not_started | 按 `ArtifactStore.findBindingByExternalRef` 统一口径实现 |
| [ ] | P1 通用 adapter 框架 + stale 三态基础 | partial | adapter packages 存在；统一 capabilities/snapshot/listTasks/publishNote 合同未完成 |
| [ ] | PA Multica Adapter | partial | readonly adopt 可作为输入证据，不等于 PLT-Adapter exit |
| [ ] | PB GitHub Issues Adapter | not_started | 需按 `32-github-issues-adapter-prd.md` 建 packet |
| [ ] | PC Linear Adapter | not_started | 需按 `33-linear-adapter-prd.md` 建 packet |
| [ ] | P2 跨 adapter 集成测试 + 架构审查 | not_started | imported_snapshot 负测试未有 |

## 文档漂移

- [ ] `00-overview.md` 仍引用不存在的 `harness/contracts/23-agent-contracts.md`。
- [x] 旧 binding lookup 术语已并入 `ArtifactStore.findBindingByExternalRef`；M2/PLT-Adapter 派工口径已同步，历史裁决记录保留原名上下文。
