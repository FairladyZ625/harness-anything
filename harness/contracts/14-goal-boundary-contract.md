# 14 · Goal Boundary Contract — 重写开工前目标边界

- **状态**: canonical
- **日期**: 2026-06-10
- **依据**: `goal-boundary/goal-boundary/SKILL.md`

## 1. 用户意图复述

在真正写第一行代码之前，把 Coding Agent Harness clean-room rewrite 的目标、非目标、证据、停止条件、迁移边界、外部资料吸收方式全部定清楚；输出一套可直接交给实现 agent 的文档包，而不是继续在旧代码上做局部兼容。

## 2. 合同级别

这是 **full contract**，理由：

- 多阶段重写，影响 CLI、存储、引擎、模板、投影、迁移和发布面；
- 目标存在扩张风险，容易被 Multica、旧代码、MBSE、Dashboard、外部 agent runtime 牵走；
- 需要多人/多 agent 分片实现；
- 会触碰公私边界、历史任务迁移、写协调、CI gate。

## 3. North Star

Harness 的核心价值不是成为 Issue Tracker，也不是成为 Agent Runtime，而是成为 **agent work artifact kernel**：

> local-first，把任务执行过程中的计划、证据、发现、复盘、lesson、关系与可审计上下文沉淀为 repo-native package；生命周期状态通过可插拔 LifecycleEngine 提供 snapshot；local engine 是默认主线，Multica/GitHub/Linear/Jira/Notion 等只是可选状态来源。

## 4. Done

本轮文档工作完成的外部可观察结果：

1. 形成一套 self-contained、canonical 的 `harness/contracts/` 文档包。
2. 明确 clean-room rewrite，不把旧 legacy state module / legacy policy module / legacy binding record 当兼容目标。
3. 明确 old Harness 的维护策略：bugfix/security/doc maintenance 继续；新功能只进 rewrite。
4. 定义 local engine、LifecycleEngine port、ArtifactStore、TemplateLibrary、WriteCoordinator、SQLite projection、statusMapping、stale snapshot、public/private publishNote、legacy intake、CI gates。
5. 每个 P0/P1 风险有对应的 contract、gate、test 或 open question owner。
6. 具备创建第一个实现任务的条件：Slice 0 文档冻结 + blocker contracts 清单明确。

## 5. Non-goals

本轮不做：

- 不实现代码；只定义开工前合同与文档包。
- 不自动迁移旧任务；只定义 agent-assisted intake/playbook。
- 不承诺旧任务结构与新结构二进制/文档级兼容。
- 不把 Multica 变成 first-class 主线；只吸收其状态机思想并实现 adapter 边界。
- 不做跨引擎聚合控制台。
- 不做 external runtime/queue/assign/rerun/cancel 的 provider-neutral abstraction。
- 不把 PRD/Module/Gate/Review 升入 Kernel。
- 不把 PostgreSQL、enterprise RBAC、多用户 portfolio 放进 open core。

## 6. Constraints

| 约束 | 具体含义 |
| --- | --- |
| Clean-room | 旧代码是 behavior corpus；新内核可以破坏旧 schema。 |
| local-first | local engine 是默认、主线、必须最好用。 |
| TypeScript + Effect | TypeScript 是实现语言；Effect 用于 typed error、Layer/service、并发队列、资源管理。 |
| Markdown SoT | 文档是事实源；SQLite 是 rebuildable projection/cache。 |
| Git 性能 | 所有高频写必须经过 WriteCoordinator；不允许无 journal 的延迟刷写。 |
| 公私边界 | private evidence/raw log/secret 永不进入外部 comment 或公开 docs。 |
| Agent 可用性 | native runtime 高频打断/纠偏/共创必须保持；Harness 不抢 runtime。 |
| 旧版维护 | 旧版只修 bug/security/doc，不再承载新功能。 |

## 7. Evidence

本轮文档包必须引用或吸收以下证据：

- 用户提供的 `goal-boundary/SKILL.md`：目标边界合同形状。
- 用户提供的 `kernel-rewrite-2026-06/`：已有 canonical 设计基线。
- 用户提供的 `lifecycle-engine-redesign/` 与 GRILL：被吸收为历史决策和风险来源。
- 用户提供的 `归档.zip`：旧源码、旧 references、旧迁移 playbook、旧 task state guide，作为 behavior corpus。
- 外部官方资料：Effect、SQLite WAL、GitHub Issues/Actions、Jira workflow、Linear method、Node test runner、TypeScript project references。
- 外部开源/论文资料：OpenHands、SWE-agent、Aider、Continue、agent manifest / coding-agent empirical papers。

## 8. Autonomy

实现 agent 可自主决定：

- 文档内部章节组织、slice 子任务拆分、测试文件命名；
- 具体 TypeScript module 名称，只要不破坏 import boundary；
- local engine 的 UI 文案，只要错误码稳定；
- SQLite 表结构，只要 rebuild invariant 成立。

必须人工确认：

- 改动 load-bearing invariant；
- 放松 binding immutability；
- 引入 provider-neutral transition；
- 引入 PostgreSQL/hosted/enterprise 功能到 open core；
- 允许旧任务自动迁移为新任务；
- 放宽 public/private redaction gate。

## 9. Stop / Escalate

立即停止并回 coordinator 的条件：

1. 任何实现 slice 需要导入旧 runtime 才能前进。
2. WriteCoordinator 没有 crash-recovery 方案却要实现 local status write。
3. Snapshot freshness 没有 stale/unavailable 策略却要接外部引擎。
4. `publishNote` 没有 redaction/idempotency 合同却要写外部 comment。
5. 任何人试图把 “agent 方便” 作为突破单引擎不可变的理由。
6. 文档、代码、测试中出现禁用词并承担新语义：`LifecyclePort`、`IssueBackend`、`syncMode`、`bindingRole`、`Harness closed`、`legacy transition request symbol`。

## 10. 开工判据

可以开始 Slice 1 的条件：

- 本目录 00–25 全部被 reviewer 读过；
- `25-blocker-decision-checklist.md` 中 P0 全部为 `closed`；
- `16-risk-register-and-confidence-loop.md` 中无 unnamed P0/P1；
- 实现任务包引用本合同，并列明本 slice 不做什么。
