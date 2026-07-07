# M2 功能拆解：任务生命周期 / Review / Closeout / publishNote

<!--
status: draft
date: 2026-06-12
covered-matrix-sections: §4 §5 §6
disposition: vertical(M2) + kernel(M2) 行
-->

---

## 1. 头信息

| 字段 | 值 |
|------|----|
| 里程碑 | M2 — Coding Vertical |
| 本文覆盖矩阵节 | §4 任务生命周期与任务包、§5 Review / Closeout、§6 Visual Map / 证据 / publishNote |
| 文件状态 | draft |
| 最后更新 | 2026-06-12 |

关键约束速查：

- **D7**：Review 逻辑不进 kernel；kernel 仅提供扩展槽。
- **D14**：DAG 不内化为 Kernel/DB 模型；visual_map.md 为人工 authored Markdown。
- **D18**：External done ≠ closeout；引擎完成不自动触发 closeout。
- **Invariant 7**：三轴（coordinationStatus / packageDisposition / closeoutReadiness）互不写入对方。

---

## 2. 功能拆解总表

### §4 任务生命周期与任务包

| 功能点 | 来源 | 验收口径 | 依赖 |
|--------|------|----------|------|
| `new-task-batch` 命令（批量创建任务） | kernel M2 | 单次调用可创建 ≥2 个任务包骨架；每个骨架自动生成随机 `task_<ULID>`；batch 不接受手写 `--id`；无副作用写入用户目录（postinstall 约束） | — |
| `brief.md` 模板 | vertical M2 | 模板落地为文件；必填字段与 task_plan.md 的 intent/scope 字段对齐；有 schema 校验通过示例 | — |
| `task_plan.md` 模板 | vertical M2 | 职责收窄为任务合同：仅含 intent / scope / acceptance / stop-condition / links；不内嵌 phase/gate 表；schema check 通过 | `brief.md` 模板 |
| `execution_strategy.md` 模板 | vertical M2 | 模板落地；字段覆盖执行策略；与 task_plan.md links 字段互引；schema check 通过 | `task_plan.md` 模板 |
| `visual_map.md` / `task_flow.md` 模板 | vertical M2 | 仅为 authored Markdown（非 runner 驱动，满足 D14）；`visual_map.md` 作为 `task_flow.md` 的 compatibility alias；内容为 Mermaid 或纯文字 DAG；不写入任何 DB/Kernel 模型 | D14 |
| `findings.md` 模板 | vertical M2 | 模板落地；含 finding-id / severity / status 字段；与 review.md severity 模型对齐 | — |
| `lesson_candidates.md` 模板 | vertical M2 | 模板落地；含候选教训条目结构；与 closeout 证据模型关联字段 | `findings.md` 模板 |
| `review.md` 模板 | vertical M2 | 模板落地；含 reviewer-stance / Confidence-Challenge / P0–P3 severity 字段；schema check 通过 | `findings.md` 模板 |
| `walkthrough.md` 模板 | vertical M2 | 模板落地；结构化 walkthrough 条目；与 review.md 互引 | `review.md` 模板 |
| `long-running-task-contract.md` 模板 | vertical M2 | 模板落地；覆盖长任务额外字段（心跳 / 中断恢复 / 超时策略）；schema check 通过 | `task_plan.md` 模板 |
| `task-phase` 命令 | vertical M2 | 命令可推进 phase（init → execution → gate）；phase actor 字段区分 human-gate / agent；human-gate 不可由 agent CLI 伪造；exit-command 字段有效 | `task_plan.md` 模板 |
| `task-review` 命令 | vertical M2 | 命令触发 review 门禁；门禁等价判定：release-blocking finding 且 severity ∈ {P0,P1,P2,P3}；通过则输出 verifier-backed review contract；不通过则阻断（满足 D7，逻辑在 vertical） | `review.md` 模板，review 门禁 checker |
| `task-archive-batch` 命令 | kernel M2 | 接收来自 vertical 的 release-closeout task list；批量归档；归档前校验 closeoutReadiness 轴为 passed（Invariant 7）；写入 packageDisposition=archived；不写入 coordinationStatus / closeoutReadiness | vertical release closeout preset |
| `task-complete` gate | vertical M2 | completion gate 链接到 vertical checkers；checker 全过后 closeoutReadiness 方可置 passed（无独立 "complete" 值）；满足三轴不互写（Invariant 7） | closeout 证据模型 |

### §5 Review、人工确认与 Closeout

| 功能点 | 来源 | 验收口径 | 依赖 |
|--------|------|----------|------|
| 对抗性审查标准（reviewer stance / Confidence Challenge） | vertical M2 | reviewer stance 文档化；Confidence Challenge 流程可执行；review.md 模板字段覆盖 | `review.md` 模板 |
| P0–P3 severity 模型 | vertical M2 | 四级 severity 定义落地；与 release-blocking finding gate 联动；findings.md 字段对齐 | `findings.md` 模板 |
| review schema check | vertical M2 | review.md schema 校验器实现；必填字段缺失时报错；可在 CI / gate 中调用 | `review.md` 模板 |
| release-blocking finding gate | vertical M2 | gate checker：存在任意 release-blocking finding（P0–P3）则阻断发布；输出阻断原因；满足 D7 | P0–P3 severity 模型，review schema check |
| verifier-backed review contract | vertical M2 | review 通过后生成 contract 文件；contract 含 reviewer-id / timestamp / finding 摘要 / verifier 签名字段 | release-blocking finding gate |
| closeout 证据模型（closeoutReadiness checker axis） | vertical M2 | closeoutReadiness 为三轴之一（Invariant 7）；checker 仅写 closeoutReadiness 轴；text/JSON 格式证据，不强制截图；与 task-complete gate 联动 | verifier-backed review contract |
| release closeout preset | vertical M2 | preset 定义 closeout 所需 checklist；输出供 `task-archive-batch` 消费的 task list；满足 D18（显式触发，非引擎自动） | closeout 证据模型 |

### §6 Visual Map、证据与进度模型

| 功能点 | 来源 | 验收口径 | 依赖 |
|--------|------|----------|------|
| canonical `visual_map.md` 合约 | vertical M2 | authored Markdown，非 runner 驱动（D14）；合约文档说明字段语义；compatibility alias `task_flow.md` 有效 | D14 |
| phase kind（init / execution / gate） | vertical M2 | 三种 phase kind 枚举落地；schema 覆盖；`task-phase` 命令校验 kind 合法性 | `task-phase` 命令 |
| phase actor（human gate 不可委托 agent） | vertical M2 | human-gate actor 字段不可由 agent CLI 自动填写；有运行时检查或文档说明的不可绕过约束 | phase kind |
| phase exit command | vertical M2 | 每个 phase 有 exit-command 字段；命令执行后推进 phase；`task-phase` 命令实现 | phase kind，phase actor |
| evidence status | vertical M2 | evidence 条目含 status 字段（pending / submitted / verified）；text/JSON 格式；无强制截图要求 | closeout 证据模型 |
| completion consistency gate | vertical M2 | gate 联合三轴校验（Invariant 7）；无互写；agent 和 human 路径均通过同一 gate | Invariant 7，三轴模型 |
| artifact index 模板 | vertical M2 | 模板落地；索引任务包产出物；含 artifact-id / type / path / status 字段 | — |
| repair prompt（checker-derived 限制修复提示） | vertical M2 | repair prompt 由 checker 输出派生；仅覆盖 checker 发现的字段；不越权修改其他轴 | closeout 证据模型，review schema check |

### §6 publishNote

> **BLOCKED**：本节全部功能点以 `harness/contracts/38-publish-note-safety-contract.md` canonical 化为 entry gate（25 §3：未补齐不得调用外部 comment API）。38 当前为 skeleton。涉及外部 comment API 的实现（idempotent `publishNote`、closeout publish 命令）在 38 锁定前不得派工；纯本地部分（`PublishableProjection`、redaction scanner）可先行，但 redaction 规则集须与 38 §2/§3 对齐。

| 功能点 | 来源 | 验收口径 | 依赖 |
|--------|------|----------|------|
| `PublishableProjection` constructor | vertical M2 | constructor 接收 task 包数据；输出可发布视图（不含敏感字段）；单元测试覆盖 | redaction scanner |
| redaction scanner | vertical M2 | 扫描 task 包输出；标记 / 剥离敏感字段；redaction 规则与 38 §2/§3 对齐；有测试用例覆盖边界 | 38 合同（规则集） |
| idempotent `publishNote` | vertical M2 | 多次调用结果一致；有幂等性测试；不重复写入 | `PublishableProjection` constructor；38 合同 canonical |
| closeout publish 命令 | vertical M2 | 命令触发 publishNote；前置校验 closeoutReadiness=passed（满足 D18）；输出发布凭证 | idempotent `publishNote`，closeout 证据模型；38 合同 canonical |
| engine-done-without-closeout WARNING | vertical M2 | 引擎完成但 closeout 未触发时，输出 WARNING（不自动 closeout，满足 D18）；WARNING 可被监控捕获 | D18 |
| `closeoutReadiness` passed checker | vertical M2 | checker 校验 closeoutReadiness 轴为 passed；仅写该轴（Invariant 7）；输出结构化 JSON 结果 | closeout 证据模型，Invariant 7 |

---

## 3. needs-decision 事项

本文件覆盖的 M2 范围内，无直接 applicable 的 needs-decision 项（#6 文档合约 Kernel、#10 Git Diff Adapter、#11 Attribution、#14 context efficiency 均不直接影响任务生命周期 / review / closeout 核心路径）。

### 边界标记：PLT-TaskTree 事项（本文件不决策）

**needs-decision #12 — Agent Self-Submitted Review Closeout Loop**（PLT-TaskTree 边界）

> review 由 agent 自动提交并自动触发 closeout 的完整闭环属于 PLT-TaskTree 范围。M2 中 human-gate 不可委托 agent（见 phase actor 行），closeout 必须显式触发（D18）。PLT-TaskTree 再讨论 agent self-submission 的安全边界与 verifier 鉴权机制。

---

## 4. 任务包拆分建议

| 任务包 ID | 名称 | 包含功能点 | 前置依赖 |
|-----------|------|------------|----------|
| **TL-01** | 任务文档模板物化 | `brief.md`、`task_plan.md`、`execution_strategy.md`、`visual_map.md`/`task_flow.md`、`long-running-task-contract.md`、artifact index 模板 | — |
| **TL-02** | Review 文档模板 + schema check | `findings.md`、`lesson_candidates.md`、`review.md`、`walkthrough.md`、review schema check | TL-01 |
| **TL-03** | Review 门禁 checker | P0–P3 severity 模型、对抗性审查标准、release-blocking finding gate、verifier-backed review contract | TL-02 |
| **TL-04** | 任务 phase 命令与 DAG | `task-phase` 命令、phase kind / actor / exit-command、canonical `visual_map.md` 合约（D14） | TL-01 |
| **TL-05** | `task-review` 命令集成 | `task-review` 命令（链接 TL-03 门禁）、`task-complete` gate | TL-03, TL-04 |
| **TL-06** | Closeout 证据模型与 preset | closeout 证据模型、evidence status、completion consistency gate（Invariant 7）、release closeout preset | TL-05 |
| **TL-07** | Kernel 批量命令 | `new-task-batch`（kernel M2，自动随机 TaskId，禁止 batch `--id`）、`task-archive-batch`（kernel M2） | TL-06 |
| **TL-08** | publishNote 子系统 | redaction scanner、`PublishableProjection` constructor、idempotent `publishNote`、closeout publish 命令、engine-done-without-closeout WARNING、`closeoutReadiness` passed checker。**BLOCKED on 38 合同 canonical（见 §6 publishNote 节）** | TL-06；38 合同 |
| **TL-09** | repair prompt | checker-derived repair prompt | TL-06, TL-08 |

> 建议执行顺序：TL-01 → TL-02 → {TL-03, TL-04}（可并行）→ TL-05 → TL-06 → {TL-07, TL-08}（可并行）→ TL-09
