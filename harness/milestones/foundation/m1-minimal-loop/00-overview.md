# M1 · 最小闭环 (Minimal Loop)

- **状态**: canonical
- **日期**: 2026-06-12

## 目标 (North Star)

Kernel + LocalLifecycleEngine + CLI 组成可独立运行的最小系统，使 harness-anything 自身开发能够切换为用新 harness 进行 dogfood 协调。M1 完成后，旧 harness 不再是唯一协调工具，新系统首次承载真实工作负载。

## 范围内 (In Scope)

- kernel/domain + kernel/ports 包骨架，含 import 边界测试（对应 Slice 1）
- WriteCoordinator、ArtifactStore（markdown 后端）、WAL/崩溃恢复（Slice 2）
- LocalLifecycleEngine + local snapshot，local 状态所有权护栏（Slice 3）
- CLI 核心命令：`harness new-task` / `harness task status set` / `harness task progress append` / `harness task archive` / `harness task list`
- Skill 初版（教会 agent 命令所有权规矩）
- SQLite 投影构建器 + `harness check` 三轴输出 + `governance rebuild`（Slice 4）
- EntityRef 引用语法定稿并写入 `02-domain-model.md`：`[harness别名:]task/<id>`，无前缀 = 本 harness；带别名前缀的引用 M1–PLT-Adapter 只存储不解析（显示为不可解析外部节点），解析器 PLT-CrossRepo 实现（裁决 2026-06-12，避免 PLT-CrossRepo 改存量数据）
- Supersession ADR（Slice 0，说明旧文档/旧代码定性）
- Application Service 签名保持未来 GUI/daemon 可映射：M1 不实现 daemon/API handler，但新增或改动的 Service 不得引入长期 `payload: unknown` public surface（见 `harness/contracts/39-daemon-api-service-contract.md`）

## 范围外 (Non-goal)

- 任何外部引擎 adapter（Multica/GitHub/Linear）
- publishNote / closeout 完整化
- Module CRUD、VerticalDefinition、PresetPackage
- 父子任务、depends-on、跨仓引用
- GUI 客户端（Electron）
- daemon API 与 API handler codegen（M1 仅保留 Service contract 可映射性）
- GUI/daemon transport、durable terminal、distribution/update、service mappability gate hardening（M2.5 负责）
- 旧 harness cutover（M2 负责）

## 入口条件

1. `00-index/` 设计包已定稿，相关 M1 决策可通过 `ha decision list --legacy-range E1-E10 --compact` 查询。
2. 所有 blocker contracts 就位（见 `30-implementation-start/11-implementation-roadmap.md` §1）：status-model、binding-integrity、snapshot-freshness、local-lifecycle-command、write-coordination。
3. harness-anything 仓库骨架已创建（`36-harness-anything-bootstrap.md` ADR 通过）。

## 验收标准

- [ ] `packages/kernel/domain` 零外部依赖（`import graph` 检查通过）
- [ ] `contracts-tests` 全绿：无 `legacy transition request symbol` 端口，无旧 import，无 sync 字段
- [ ] WAL 崩溃恢复：`kill -9` 后重放不丢不重
- [ ] same-task 写操作 FIFO 顺序保证（测试覆盖）
- [ ] 绑定块只写一次，修改被 domain 拒绝
- [ ] S1 场景端到端通过，零外部依赖
- [ ] `harness task list` 可列出活跃任务；状态 6 态非法值被 domain 拒绝
- [ ] SQLite 删除后 `governance rebuild` 语义等价恢复
- [ ] `harness check` 三轴联合输出格式符合 `02 §3` 定义
- [x] harness-anything 的 `harness` 中至少一个真实任务包用新 harness 协调完成（dogfood 证据；M1 无 closeout 完整化，dogfood 任务以实现后的 M1 domain 词表记录为准：`coordinationStatus=open`、`packageDisposition=active`、`closeoutReadiness=not_required` 且 check 零 warning。旧版 `coordinationStatus=done` 口径已废弃；engine done ≠ closeout，closeout 完整化属 M2）
- [ ] Supersession ADR 通过评审，明确旧代码定性

## 依赖

- 前序里程碑：无（M1 是起点）
- 关键设计文档：
  - `10-foundation/02-system-architecture.md`（三轴状态、6 态）
  - `10-foundation/03-code-architecture.md`（绑定不可变、snapshot-freshness、local-lifecycle-command）
  - `harness/contracts/37-write-coordination-contract.md`（WAL/锁/崩溃恢复）
  - `harness/contracts/39-daemon-api-service-contract.md`（M1 Service 签名可映射性约束；不要求 M1 实现 daemon）
  - `30-implementation-start/11-implementation-roadmap.md`（Slice 0–4 细节）

## 待细化任务清单

> 待 parity 矩阵（`harness/milestones/01-parity-matrix.md`）评审后填充具体 task packet 列表。
