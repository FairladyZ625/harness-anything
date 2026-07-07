# M2 · Coding Vertical 对齐 (Coding Vertical Parity)

- **状态**: canonical
- **日期**: 2026-06-12
- **2026-06-14 修订**: 本文中的 `cutover`、`唯一事实 coordinator`、strict cutover gate 和 full-semantic task migration 是 M2 历史目标口径。M2-P7 证据保留为 historical/deprecated；未来 dogfood 和旧任务处理由 M2.5-CLI 的 Legacy Intake + forward-only dogfood 替代。

## 目标 (North Star)

历史 M2 目标是让旧 harness 在 coding 场景下的日常功能——任务包、review、preset、check、migration——在新内核完整等价可用，并收集旧路径 cutover 证据。2026-06-14 起，这个目标不再解释为未来 full cutover；未来以 M2.5-CLI 的 Legacy Intake、additive preset、completion gate 和 forward-only dogfood 为准。

## 范围内 (In Scope)

- Module CRUD（Slice 7）
- VerticalDefinition / PresetPackage 解析；software/coding vertical 声明（Slice 7）
- Template Library 单 root + locale（Slice 7）
- publishNote 安全发布 + redaction scanner（Slice 6）
- closeoutReadiness 完整 checker（Slice 6）
- `harness adopt` + MulticaLifecycleEngine 只读（Slice 5）
- legacy budget 映射；agent-assisted migration 流程
- Historical cutover evidence：旧 CLI/包路径指向新实现、import graph 零旧依赖（Slice 8）；未来策略已退役，不再作为新任务 gate
- parity 矩阵（`01-parity-matrix.md`）所有绿列覆盖
- M2 新增的 task、review、closeout、preset application Service 保持 GUI/daemon 可映射；M2 不实现 daemon/API handler，但不得新增不可生成 API 的长期 Service surface（见 `harness/contracts/39-daemon-api-service-contract.md`）

## 范围外 (Non-goal)

- 父子任务、depends-on（PLT-TaskTree）
- 外部 adapter 写操作（PLT-Adapter）
- 跨仓引用（PLT-CrossRepo）
- GUI v2（GUI-V2）
- daemon API 与 API handler codegen（M2 只承担 Service contract 可映射性，不承担 handler 实现）
- GUI/daemon transport、durable terminal、distribution/update、service mappability gate hardening（M2.5 负责）
- 旧 schema 兼容：新内核不以旧 schema 兼容为目标（见 `01-prd.md` §0 修正 1）

## 入口条件

1. M1 验收通过（dogfood 切换完成）。
2. `harness/milestones/01-parity-matrix.md` 评审完成，待覆盖功能列表确认。
3. `harness/contracts/38-publish-note-safety-contract.md` 成文（publishNote 安全规则集，Slice 6 前置）。
4. `40-gui-and-apps/31A-electron-security-contract.md` 被 Slice 7.5 task packet 引用（若 GUI 与本里程碑并行）。

## 验收标准

- [ ] `09 §4` 替换完成证据全部满足（historical only；未来不再作为 full cutover gate）
- [ ] `import graph` 零旧依赖（retired-path 文本扫描通过；historical only）
- [ ] parity 矩阵绿列全覆盖（所有旧日常功能在新内核有等价操作）
- [ ] 新 vertical 零内核改动可声明（fail-closed 冲突测试通过）
- [ ] 模板 locale 等价性检查通过
- [ ] redaction 夹具全拦（publishNote 安全发布）
- [ ] `engine-done-without-closeout` WARNING 正确触发
- [ ] `harness adopt` 重复执行被 `ArtifactStore.findBindingByExternalRef` 拦截；merge 后出现同一 externalRef 多绑定时，`check --post-merge` hard-fail `duplicate_external_binding`
- [ ] Multica stale-but-usable：拔网线后快照可读
- [ ] 行为语料报告产出，差异四分类完整

## 依赖

- 前序里程碑：M1
- 关键设计文档：
  - `30-implementation-start/11-implementation-roadmap.md`（Slice 5–8 细节）
  - `10-foundation/09-boundaries-deletions.md`（D1–D20 删除清单，§4 替换完成证据）
  - `harness/contracts/38-publish-note-safety-contract.md`（publishNote 安全）
  - `harness/contracts/39-daemon-api-service-contract.md`（M2 Service 签名可映射性约束；daemon/API handler gate 是后续 GUI/daemon entry）
  - `50-adapters/32-github-issues-adapter-prd.md`、`33-linear-adapter-prd.md`（adapter PRD，供评估）
  - `harness/milestones/01-parity-matrix.md`（功能等价矩阵）

## 待细化任务清单

> 待 parity 矩阵（`harness/milestones/01-parity-matrix.md`）评审后填充具体 task packet 列表。
