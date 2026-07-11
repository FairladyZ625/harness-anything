# 出处、裁决与事件账本

[决策 vs 裁决](../../learn/zh/02-decision-and-verdict.md) 划下了一条硬线:decision 回答*我们走哪条路?*,verdict 回答*这个具体的输出成立吗?*——把两者混为一谈,会让其中一个悄悄吞掉另一个。本页展示把它们分开的机械装置,以及它们所依赖的两种记录结构:把每个实体绑定到产生它的那次运行的 `provenance[]`,以及 Exit Gate 用来核对完整性的那本 append-only 事件账本。

## 出处:每个实体都写明自己的来源

磁盘上的每一个实体都携带一个 `provenance[]` 数组,而且要求**至少有一条**。provenance 就是把一条记录绑定到产生它的那次运行的东西,好让没有任何实体脱离来源、凭空漂着。

单条 provenance 记录很小,也很严格。它的 schema(`packages/kernel/src/schemas/common.ts` 里的 `ProvenanceEntrySchema`)恰好是三个字段,全都不能为空:

| 字段 | 含义 |
|---|---|
| `runtime` | 由哪个 agent runtime 产生——`human`、`claude-code`、`codex`、`zcode`、`antigravity` 之一 |
| `sessionId` | 执行写入的那个会话 |
| `boundAt` | 这次绑定被盖章的时间戳 |

因为这个字段是一个*数组*,一个实体在经过不止一次运行时可以累积不止一条绑定——但它永远不能有零条。一个来源为空的实体,是一条你无法追溯的记录,而 schema 不允许这样的记录存在。

## 回填路径

provenance 是必需的,但早于这条要求的记录、或从别处导入的记录,可能到来时并不带它。有一条专门的路径来补上这个缺口:`packages/cli/src/commands/core/provenance-backfill.ts`,以 `ha migrate-provenance` 运行。

它有两种模式。`dry-run` 只报告;`apply` 才写入。扫描会遍历每一个 task `INDEX.md`,跳过任何不是 task 包的东西(schema 不对,或根本没有 frontmatter),对每个真实的 task 包检查 `provenance:` 是否已经带有一条记录。如果有,该 task 被计为**已存在**并原封不动。如果没有,就构造一条合成记录——盖上当前会话的 runtime、一个生成的回填会话 id、以及一个 `boundAt` 时间戳——用 `ProvenanceEntrySchema` 校验,再补进 frontmatter。

这里有两个性质要紧。第一,回填是**幂等的**:一个已经有 provenance 记录的 task 永远不会被叠加成两条。第二,被应用的写入不直接落盘——它们走写协调器(见[写路径](02-write-path.md)),所以即便是一次批量迁移,产生的也是和任何其他承重变更一样的、可追溯的原子写入。

```text
扫描每个 task INDEX.md
    │
    ├─ 不是 task 包 ────────────────▶ 跳过
    ├─ provenance[] 已存在 ─────────▶ 已存在(原封不动)
    └─ provenance[] 缺失
           │  构造合成记录 {runtime, sessionId, boundAt}
           │  用 ProvenanceEntrySchema 校验
           ▼
        dry-run:只报告   │   apply:经写协调器补入
```

## 裁决:是一个判断,不是一个 decision 实体

**verdict（裁决）**是 Reviewer 对某个 submitted Execution 的语义判断。`review/v2` 的封闭
值域是 `approved`、`changes_requested`、`dismissed`，并且必须记录 `evidence_checked` 与
非空 rationale。机械 locator/digest/receipt 检查不会产出 verdict；Reviewer 读取 Task intent、
六字段 Submission Packet 与可用 Evidence 后裁决这一轮（依据 `dec_mrg3z1we/CH3-CH4`、
ADR-0027 D5-D6）。

值得着重强调的结构性事实，是 verdict **不是** decision 实体。它拿不到 `dec_` 式 id，
不进入 decisions 目录，也不上 decision 队列。它落在绑定到被判断 Execution 的不可变 Review
Entity 中，留在那一轮交付旁边，而不是被提拔为塑造未来工作的长期选择（ADR-0027 D5）。

| | Decision | Verdict |
|---|---|---|
| 问题 | 走哪条路?(WHY) | 这一轮交付成立吗? |
| 记在哪里 | `decisions/` 里的一个 decision 实体 | 某个 Execution 的不可变 `review/v2` |
| 上 decision 队列? | 是 | 否 |
| 可推翻 | 后来的 decision 能推翻它 | 一次性,默认 fail-closed |

## Session binding 的 capture range

Session provenance 通过带稳定 `range_id`、role 与含首尾 timestamp interval 的 binding 关联
到 Execution。`start_at` 是 attach 时间；active 时 `end_at` 为 null，在 submit 或 review 时
封存。这个区间描述 observer 的 capture responsibility，不证明每条 transcript event 都有
timestamp。legacy binding 暴露未指定区间，而不是搜索 transcript prose 推断归属（ADR-0027 D1）。

## 路由不是自动的

如果 verdict 不是 decision,那什么时候才会有 decision 从它里面产生?只有当这个 verdict 暴露出某种*战略性*问题时——"这批结果说明我们可能选错了路"。而即便到那时,路由也**不是自动的**。流水线里没有任何东西会自己把 `changes_requested` 变成新 decision。日常负面 verdict 只会阻止 acceptance，不会开出 decision；战略性 verdict 只是**促使**人刻意提出新 decision。

这正是 decision 队列之所以能保持有意义的机制性原因。如果每次日常裁决都自动创建 decision，队列会被逐条记账填满。把 verdict 留在与 Execution 绑定的 Review 记录里、把升级设成刻意步骤，日常 verdict 的洪水就到不了那条人类应该盯住的队列（ADR-0027 D5）。

## 运行时事件账本

运行时事件账本是一次运行期间**发生过什么的 append 记录**:会话启动、轮次、步骤、工具调用、审批、中断、结果、成本。它是活动的原始日志,按会话保存,也是 Exit Gate 在核对一项工作是否真正完成时会读的结构之一。

每一条事件都符合 `RuntimeEventRecordSchema`(`packages/kernel/src/schemas/runtime-event.ts`,schema 标签 `runtime-event/v1`)。一条事件有一个稳定的 `evt_` 前缀 id、一个 `recordedAt` 时间戳,以及一个取自固定集合的 `kind`:

```text
session · turn · step · tool · approval · interrupt · result · cost
```

每条事件都写明它的 `session`(带 runtime,以及可选的它触及的 `taskId`、`decisionId` 或 `factRef`),然后携带恰好一个与其 kind 相匹配的、被填充的细节块——`tool` 块写明工具名和任何错误码;`approval` 块记录 `approved` / `rejected` / `timeout`;`result` 块记录 `started` / `succeeded` / `failed` / `cancelled`;`cost` 块记录 token 与墙钟时间。CLI 面(`packages/cli/src/commands/core/runtime-event.ts`)只提供恰好两个操作:**append** 一条新事件,和 **list** 一个会话的事件。没有编辑,也没有删除——账本只会增长。

## 各部分如何相连

三种彼此独立的结构,一条问责的主干:

```text
provenance[]     ──▶  每个实体写明产生它的那次运行
事件账本          ──▶  每次运行都留下一条 append-only 的活动痕迹
账本上的 verdict  ──▶  每个被判断的输出都被记录在工作旁边

Exit Gate 读事件账本以核对完整性(见 04-gates-in-the-pipeline)
一个战略性的 verdict → 由人提出一个新 decision(见 learn/02)
```

provenance 回答*谁产生了这条记录*。事件账本回答*按顺序发生了什么*。verdict 回答*这一个输出成立吗*。三者都不是 decision,也都不会悄悄变成 decision——从 verdict 升级到 decision 永远是一个刻意的人类动作,而这恰恰是让 decision 主干、以及盯着它的那个队列,始终值得一读的原因。这条分离背后的"为什么",是[决策 vs 裁决](../../learn/zh/02-decision-and-verdict.md)里的论证;它所汇入的那个"完成",则是[采用律](../../learn/zh/05-adoption-law.md)。
