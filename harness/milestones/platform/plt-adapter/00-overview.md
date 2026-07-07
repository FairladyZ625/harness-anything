# PLT-Adapter · 外部 Adapter (External Adapters)

- **状态**: canonical
- **日期**: 2026-06-12

## 目标 (North Star)

Multica、GitHub Issues、Linear 三个外部生命周期引擎的状态映射与关系映射稳定可用。`imported_snapshot` 关系与 local 声明的边界清晰隔离，分歧时并排呈现而非自动调和。Harness 只消费外部引擎状态，不写入、不驱动。

## 范围内 (In Scope)

- MulticaLifecycleEngine：完整状态映射（7 态→6 态）、关系映射（见下）
- GitHubLifecycleEngine：按 `32-github-issues-adapter-prd.md`
- LinearLifecycleEngine：按 `33-linear-adapter-prd.md`
- 关系映射表（engine-owned）：默认词典 + 用户覆盖配置
- `imported_snapshot` 关系类型：标记为快照来源，不进门禁/环检测/影响分析
- local 声明与 `imported_snapshot` 分歧时：并排展示，不自动调和
- adapter 只读原则：零 lifecycle/status/metadata 写操作（不 transition、不 assign、不改外部字段）
- `publishNote`（追加评论）是唯一例外写路径：独立 publish-safety-gated packet，受 `harness/contracts/38-publish-note-safety-contract.md` 约束，38 未 canonical 化前不得调用外部 comment API（25 §3）

## 范围外 (Non-goal)

- 任何向外部引擎写 lifecycle 状态/metadata——不做（`publishNote` 评论是唯一例外，受 38 合同 gate）
- `imported_snapshot` 参与门禁或影响分析——不做
- 外部引擎聚合看板（Harness 不是统一 control plane）——不做
- 自动调和 local 与外部分歧——不做
- Jira/Plane/Asana/Trello（候补或不做，见 11 §V1.1）
- 跨仓关系映射（PLT-CrossRepo 负责）

## 入口条件

1. M2 验收通过（kernel + local engine + CLI 稳定，cutover 完成）。
2. `50-adapters/32-github-issues-adapter-prd.md` 定稿（G2/G3 锁定）。
3. `50-adapters/33-linear-adapter-prd.md` 定稿（L2/L3 锁定）。
4. `imported_snapshot` 关系类型在 schema 合同中明确定义。

## 验收标准

- [ ] Multica golden 夹具全过（7 态映射、错误翻译、stale 三态）
- [ ] GitHub golden 夹具全过（`32 §7` 验收标准全满足）
- [ ] Linear golden 夹具全过（`33 §7` 验收标准全满足，含评论 marker 规范）
- [ ] 拔网线后各 adapter：stale-but-usable，快照可读，无异常崩溃
- [ ] `imported_snapshot` 关系不出现在门禁检查路径中（代码审查通过）
- [ ] `imported_snapshot` 不出现在环检测输入中（负测试用例通过）
- [ ] `imported_snapshot` 不影响 `harness check` 三轴评估（负测试用例通过）
- [ ] local 声明与 imported 分歧时：`harness task show` 并排输出两者，无自动合并
- [ ] `ArtifactStore.findBindingByExternalRef` 拦截重复 adopt；merge 后重复 externalRef 报 `duplicate_external_binding`（各 adapter 测试通过）
- [ ] 关系映射表支持用户覆盖配置（集成测试覆盖默认词典 + 覆盖场景）
- [ ] 零内核改动可新增 adapter（架构审查通过）

## 依赖

- 前序里程碑：M2（PLT-TaskTree 可并行评估，PLT-Adapter 不依赖 PLT-TaskTree）
- 关键设计文档：
  - `10-foundation/03-system-architecture.md`（snapshot-freshness §8，stale 三态）
  - `50-adapters/32-github-issues-adapter-prd.md`
  - `50-adapters/33-linear-adapter-prd.md`
  - `harness/contracts/23-agent-contracts.md`（§9 fixtures 合同测试）
  - `30-implementation-start/11-implementation-roadmap.md`（Slice 5、9、10 细节）

## 待细化任务清单

> 待 parity 矩阵（`harness/milestones/01-parity-matrix.md`）评审后填充具体 task packet 列表。
