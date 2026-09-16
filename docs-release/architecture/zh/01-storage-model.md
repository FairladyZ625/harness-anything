# 撰写记录如何落盘

[三原语内核](../../learn/zh/01-three-primitive-kernel.md) 主张 decision、task、fact 就是整个
内核,并且它们存储得不对称——decision 集中式、task 是容器、fact 独立存储。这一页展示这套主张
落成真实文件时的样子:目录、每个文件必须携带的契约,以及模式所强制的 ID 形状。

撰写 Markdown 是已接受实体的发布文档面。
`packages/kernel/src/store/sqlite-task-event-store.ts` 从 canonical SQLite
事件与必需对象派生文档。
下列目录说明撰写面；接受边界见[唯一写路径](02-write-path.md)。

## 目录结构

```text
  <仓库根>/
  ├── decisions/                          集中式:主干
  │   └── decision-dec_<id>/              每个 decision 一个目录
  │       └── decision.md                 frontmatter: decision-package/v1
  │
  ├── tasks/
  │   └── task_<24 hex>-<slug>/           每个 task 一个目录
  │       ├── INDEX.md                    frontmatter: task-package/v2
  │       ├── task-contract.json          机器持有: task-contract/v1
  │       ├── task_plan.md                叙述:计划
  │       ├── closeout.md                 叙述:收尾与提交 packet 来源
  │       ├── executions/exe_<24 hex>.md  一轮不可变交付
  │       ├── reviews/rev_<id>.md         一轮不可变裁决
  │       └── artifacts/                  派工与交付工件
  │
  ├── facts/
  │   └── F-<Crockford-8>.md              每条记录一个托管 fact 文档
  │
  ├── sessions/
  │   └── <session-id>.md                 捕获的 Session manifest
  │
  ├── entities/                           附属 artifact 实体
  │   └── architecture-decision-records/ADR-<id>.json
  │
  └── <local root>/store/generations/<generation>/
      ├── ledger.sqlite                   canonical 事件台账
      └── objects/sha256/<2 hex>/<62 hex> 内容寻址对象
```

三个原语各有撰写存储位置。**Decision** 一起住在顶级 `decisions/` 目录里——它们是唯一一个
应该让人类盯着看的投影,所以被放在一处;每个 decision 是它自己的目录
`decision-dec_<id>/`,实体记录是其中的 `decision.md`。**Task** 是容器:每个 task 是它自己的
目录 `task_<24 hex>-<slug>/`,里面放着契约文件与叙述文档。**Fact** 有自己的顶级 `facts/`
目录,每条记录对应一个 `facts/F-<id>` 文档。与 task 关联的 fact 另有一条 active 的
`task/<id> -> fact/F-<id>` `produces` 边;独立 fact 则没有这条边。

canonical 内容对象位于 active local `store/generations/<generation>/objects/sha256/`，
与 `ledger.sqlite` 配套保存。`packages/kernel/src/store/sqlite-event-store.ts`
校验必需内容声明，先同步对象字节与目录链接，再接受引用它们的事件。撰写树的对象副本属于发布产物。

## 执行链

Execution 是 task 下的一轮交付:`executions/exe_<id>.md`,schema `execution/v1`,持有
actor、`sessionBindings` 与 `submission`。它不是由 CLI 参数拼出来的——`ha task submit`
不接受提交 packet 参数,而是由 daemon 从任务包里已写实的 `closeout.md` **派生**
Submission(`packages/daemon/src/repo-cell-submit.ts`)。closeout 的 Summary 必须点名
一个交付 commit,或至少一个 `artifact:path@revision` 锚;`deliverables` 由该 commit 的
`git diff` 求出,`outputs` 记录删除路径与 artifact 锚,`artifacts`/`commitSha` 一并落定。
最终 packet 是六个字段:`completionClaim`、`deliverables`、`outputs`、
`verificationNotes`、`knownGaps`、`residualRisks`。派生失败以
`closeout_placeholder` 或 `invalid_submission` 拒绝;已提交的 cut 内容变化时须显式
`ha task submit --amend`。

Review 是针对某个 submitted Execution 的独立不可变文件,schema `review/v1`
(`packages/kernel/src/domain/review.ts`):`verdict` 取值 `approved`、
`changes_requested`、`dismissed`,必须带非空 `reason` 与 `evidenceChecked[]`,并按
`submissionDigest` 绑定到那一轮提交。`review-consent/v1` 再把同意钉在同一份
review 与 submission digest 上(`ha task review-consent`)。

## decision 文件

一份 decision 文档携带的 frontmatter 对着 `decision-package/v1` 校验
(`packages/kernel/src/domain/decision-event-document.ts`)。那些承重的字段:

| 字段 | 装的是什么 |
|---|---|
| `decision_id` | 稳定 ID,模式 `dec_...` |
| `title` | 这个选择,一句话 |
| `state` | `proposed`、`in_effect`、`rejected`、`deferred`、`superseded`、`outcome_retired` |
| `riskTier` | `low` / `medium` / `high` |
| `urgency` | `low` / `medium` / `high` |
| `vertical`、`preset` | 它属于哪个领域和哪个 preset |
| `decisionClass` | `ordinary` 或 `standing_policy` |
| `applies_to` | `{ modules[], productLines[] }` —— 它的作用范围 |
| `workspaceRevision` | 裁决时的 canonical revision |
| `proposer`、`arbiter` | 提议者与裁决者,各为 `{ principal, executor }` 行动者身份 |
| `proposedAt`、`decidedAt` | 提议与裁决时间戳 |
| `question` | 正在被决定的是什么 |
| `chosen[]` | 被采纳的选项(每个是 `{ id, text, rationale }`) |
| `rejected[]` | 未采纳的选项,每个都带一个 `whyNot` |
| `claims[]` | 承重主张,每个是 `{ id, text, loadBearing, fulfillment }` |
| `relations[]` | 指向其他实体的类型化边 |
| `judgmentConsents[]` | 钉在具体内容 pin 上的裁决同意记录 |
| `provenance[]` | 恰好一条会话身份,把它绑定到产生它的那次运行 |

**行动者身份与裁决角色。** `proposer` 与 `arbiter` 都是 `ActorIdentity`——
`principal`(人)加可选 `executor`(代行的 agent)。decision 的 outcome 动作在行动层绑定
arbiter 角色:agent 不能裁决自己的提议
(`packages/kernel/src/domain/entity-field-contracts.ts`)。裁决不是写进字段就完事,
而是由 `decision-judgment-consent/v1` 记录钉在具体 `decision-content-pin/v1` 上的同意。

接受操作由 SQLite command outcome 与事件区间定位；见
`packages/kernel/src/store/sqlite-event-store.ts` 和[唯一写路径](02-write-path.md)。

## task 包

一个 task 是一个目录,`task_<24 hex>-<slug>/`。目录里,`INDEX.md` 是实体记录,
其 frontmatter 对着 `task-package/v2` 校验:

| 字段 | 装的是什么 |
|---|---|
| `task_id` | task 的稳定 id |
| `title` | 这个 task 是什么 |
| `lifecycle` | 生命周期绑定 `{ engine: kernel/task-lifecycle/v1, status }` |
| `packageDisposition` | 包的处置状态 |
| `workKind` | 工作类别(docs、code 等) |
| `riskTier`、`urgency` | 风险与紧急度 |
| `vertical`、`preset`、`profile` | 领域、preset 与 profile |
| `packagePath` | 包在仓库里的路径 |
| `owner` | INDEX.md 本身的属主(`machine`) |

task 的 `status` 活在它的 `lifecycle` 绑定里,而它是一台真实的状态机——一个 task 会在
`planned`、`active`、`blocked`、`in_review`、`done`、`cancelled` 之间流转。
`task-contract.json`(`task-contract/v1`)是机器持有的契约:task class、vertical/preset/profile、
`presetSnapshotDigest`、脚手架 digest、completionGates,以及每份文档的 slot 与属主
(`machine` 或 `doc-sync`)。`INDEX.md` 的 `## Documents` 节逐份列出这些属主:
机器文件由 daemon 重写,`doc-sync` 属主的叙述文档(`task_plan.md`、`closeout.md` 等)
经 `ha doc status` / `ha doc sync --submit` 流转。task 状态来自 canonical 事件；
`packages/kernel/src/store/sqlite-task-event-store.ts` 将其文档视图发布到 `INDEX.md`。

## Fact 文档

fact 记录为 `facts/F-<id>.md` 托管文档——它不是 frontmatter 文件,而是由
`ha fact record` 维护的 `# Facts` 文档,`## Records` 下每条记录一节。字段:

| 字段 | 装的是什么 |
|---|---|
| `F-<id>` | 模式 `F-` + 8 个 Crockford base32 字符 |
| `Statement` | 观察本身 |
| `Evidence source` | 观察从哪里来 |
| `Observed at` | 何时观察到的 |
| `Confidence` | `low` / `medium` / `high` |
| `State` | `standing` 或 `superseded_fact` |
| `Task` | 可选,归属的 task |

文档只打印召回需要的字段;完整事件载荷(`fact-event/v1`,
`packages/kernel/src/domain/fact-event.ts`)还携带 `memoryClass`、`memoryTags`、
可选 `taskId`、`domainTypes`,以及把旧记录标记为 `superseded_fact` 的
`supersedes: { factRef, rationale }`。

**Fact 是仅追加的(append-only)。** 一个 fact 由 `ha fact record` 创建;纠错通过追加一条
带 `supersedes` 的新记录完成,而不是编辑旧记录。这正是 fact 能被当作证据信任的原因:
你读到的陈述就是当初被记录下来的陈述,旁边还有说明它在什么条件下被观察到的出处。

append-only 并不意味着每一次重复追加都会报错。当 fact append 重放一条已有 `fact_id` 的记录时，
存储层会比较格式化后的记录字节。如果现有记录与传入记录逐字节相同，这次追加就是幂等 no-op，文件
正文保持不变。如果 id 相同但字节不同，写入仍会作为重复 fact id 被拒绝。

## 共同的那根线:可归因

三种实体的可归因方式各不相同,但都不允许匿名写入。decision 的 frontmatter 携带
`provenance[]`——恰好一条 `SessionProvenanceV1`:`runtime`(产生它的运行时名)、
`sessionId`、`transcriptReachability`、`boundAt`
(`packages/kernel/src/domain/agent-runtime.ts`)。task 包的归属由
`task-contract.json` 与文档属主声明承载;fact 由 `Evidence source` 与 `Observed at`
承载。而三者背后,每条 canonical 事件的信封都带 `actor`(`principal` + `executor`)与
`source`——任何一条落盘记录都能回答"这是谁、或什么,在何时写下的"。出处的完整故事在
[06 · 出处、裁决与事件账本](06-provenance-and-events.md)。

下一个问题是:当这些文件之一被写下时,会发生什么——一条记录到底如何安全、可归因地抵达磁盘。
那就是 [02 · 单一写路径](02-write-path.md)。
