# 18 · Schema Contracts 与验证边界

- **状态**: canonical
- **日期**: 2026-06-10

## 1. 原则

所有跨边界数据必须有 schema：

1. **authored input**：`harness.yaml`、frontmatter、template catalog、vertical/preset manifest；
2. **external input**：Multica/GitHub/Jira/Linear/Notion snapshot raw payload；
3. **generated/cache**：SQLite row、projection JSON、dashboard bundle；
4. **public output**：publishNote payload、docs-release promotion bundle；
5. **journal**：WriteCoordinator op log。

Schema 的职责不是“漂亮类型”，而是防止 agent 和 adapter 把不可信字符串悄悄变成事实。

## 2. `harness.yaml` v2

2026-06-12 协作修订：产品默认 storage schema 必须区分 shared authored root 与 local
generated/runtime root。`markdownRoot` 是 legacy/private bootstrap alias，新实现应使用下列字段。

```yaml
schema: harness/v2
project:
  id: legacy harness
  locale: zh-CN
lifecycle:
  default: local
  enabled: [local, multica]
  engines:
    local:
      kind: local
    multica:
      kind: multica
      workspace: <workspace>
      project: <project>
vertical:
  default: software/coding
presets:
  default: standard-task
storage:
  authoredRoot: harness
  generatedRoot: .harness/generated
  cacheRoot: .harness/cache
  sqlitePath: .harness/cache/projections.sqlite
  journalPath: .harness/write-journal
  lockPath: .harness/locks
  privateHarnessRoot: harness # optional deployment mode, not product default
```

Validation：

- `lifecycle.default ∈ lifecycle.enabled`；
- `enabled[*]` 必须有 `engines.<name>`；
- `kind` 决定 adapter factory；
- open core 不接受 enterprise-only config。
- `storage.authoredRoot` must be tracked/shared by Git unless the deployment explicitly declares `privateHarnessRoot` mode。
- `storage.generatedRoot`、`cacheRoot`、`journalPath`、`lockPath` must be outside `authoredRoot` by default and gitignored。
- generated output under `authoredRoot` is valid only for explicit export/snapshot artifacts with provenance。
- `privateHarnessRoot` is optional and cannot silently replace product default authored root in public init flows。

## 3. Task frontmatter v2

```yaml
---
schema: task-package/v2
task_id: task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q
title: Example Task
slug: example-task
lifecycle:
  bindingSchema: lifecycle-binding/v1
  engine: local
  status: active          # only when engine=local
  ref: null               # external only
  titleSnapshot: null
  url: null
  bindingCreatedAt: 2026-06-10T00:00:00.000Z
  bindingFingerprint: sha256:...
packageDisposition: active
vertical: software/coding
preset: standard-task
# 2026-06-16 三元语回写(E47/E49):task 继承 decision 的元字段
riskTier: medium                      # low|medium|high —— 默认从 spawningDecision 继承,可覆盖
urgency: medium                       # low|medium|high —— 同上(E47)
spawningDecision: dec_01K7Z...         # 该 task 由哪条 decision 派生(生成式派生时必填;顶层独立 task 可空)
provenance:                            # entity 原文溯源数组(E47/44);与 §9 relation.provenance 同名不同义
  - runtime: claude-code
    sessionId: 88833871-9d1c-...
    boundAt: 2026-06-16T03:10:00Z
---
```

> 注:`riskTier`/`urgency`/`provenance`/`spawningDecision` 为三元语新增(2026-06-16 回写)。task **默认从 spawning decision 继承** riskTier/urgency/provenance,可覆盖;**顶层独立 task**(无 spawning decision)则自填。此为 task-package/v2 的增量字段,向后兼容(旧包缺这些字段→warning 提示继承/补填,非 error)。

Validation：

| 条件 | 结果 |
| --- | --- |
| `task_id` 缺失或不是随机稳定 ID 格式 | error |
| 两个 authored packages 具有同一 `task_id` | error：`duplicate_task_id`；post-merge checker 必须阻断 |
| 目录 slug 与 frontmatter `slug` 不一致 | warning：`task_slug_conflict`；修 locator/frontmatter slug，不得改变 `task_id` |
| `engine=local` 且无 `status` | error |
| `engine!=local` 且有 `status` | warning/error：外部状态不写入 authored truth；只允许 last snapshot cache 在 generated/cache。 |
| `engine` 或 `ref` 与 fingerprint 不符 | `binding_tampered` |
| `packageDisposition=archived` 但目录仍在 active tree | error |
| titleSnapshot 与外部 title 不同 | warning only；不改目录名。 |

## 4. Journal op schema

```ts
type WriteOp =
  | { kind: "package_create"; taskId: TaskId; payload: PackageCreatePayload; opId: string; actor: ActorRef; at: string }
  | { kind: "transition_local"; taskId: TaskId; to: CanonicalStatus; opId: string; actor: ActorRef; at: string }
  | { kind: "progress_append"; taskId: TaskId; text: string; opId: string; actor: ActorRef; at: string }
  | { kind: "doc_write"; taskId: TaskId; path: string; bodySha256: string; bodyPath: string; opId: string; actor: ActorRef; at: string }
  | { kind: "package_archive"; taskId: TaskId; reason: string; opId: string; actor: ActorRef; at: string }
```

Hard rules：

- opId 幂等；重放同一 op 不重复写；
- large body 不直接写 journal；journal 引 body blob path + hash；
- same-task FIFO；跨 task 可重排但 commit message 要列 op ids。

## 5. TaskSnapshot schema

```ts
type TaskSnapshot = {
  canonicalStatus: DomainStatus | "unknown"
  rawStatus: string
  freshness: "fresh" | "stale-but-usable" | "unavailable-no-cache"
  fetchedAt: string
  expiresAt?: string
  staleReason?: string
  source: "local-document" | "external-engine" | "snapshot-cache"
  engine: EngineId
  ref?: string
  assignee?: string
  parentRef?: string
  url?: string
  title?: string
}
```

`DomainStatus = "planned" | "active" | "blocked" | "in_review" | "done" | "cancelled"`。
`unknown` 只能来自 unmapped raw status 的 snapshot decode；不能写回 domain，也不能被 adapter 用作“懒得映射”的默认值。
`source/engine/ref` 是 cache、dashboard、stale 行为和 duplicate-binding checks 的必备字段；实现不得用只含 status/freshness 的缩略 snapshot 作为公共 DTO。

## 6. PublishableProjection schema

```ts
type PublishableProjection = {
  visibility: "public-safe"
  title: string
  summary: string
  links: ReadonlyArray<{ label: string; href: string; kind: "artifact" | "commit" | "review" }>
  redactionReport: {
    scannerVersion: string
    findings: ReadonlyArray<RedactionFinding>
    passed: true
  }
  idempotencyKey: string
}
```

Validation：

- `visibility` 无其它合法值；
- `summary` 有长度预算；
- `href` 不得指向 private-only raw file；
- `redactionReport.passed` 必须为 true；
- `idempotencyKey = sha256(engine + ref + projectionVersion + contentHash)`。

## 7. Schema publication

每个 schema 需要三个产物：

1. TypeScript type / Effect Schema；
2. JSON Schema（供外部工具和 docs 验证）；
3. golden fixtures（valid/invalid）。

CI gate：schema 变更必须更新 fixtures 和 migration note。

## 8. Decision package schema（2026-06-16 三元内核回写;出处 13 E35–E44、41/42）

`decisions/decision-<id>/decision.md` frontmatter。Decision 是 why 轴脊梁实体,与 task/fact 正交。

```yaml
---
schema: decision-package/v1
decision_id: dec_01K7Z...            # ULID,复用 task ID 生成器
title: 内核改为三元语 decision/task/fact
state: proposed                       # proposed|active|rejected|deferred|retired
riskTier: high                        # low|medium|high —— 风险/重要性,驱动派生 pipeline 深度(评审多严)
urgency: medium                       # low|medium|high —— 紧急,驱动决策队列排队顺序(与 riskTier 正交,见 doc 44)
vertical: software/coding
preset: architecture-decision         # decision 也走 materialize(entity,preset,vertical)
applies_to:                           # scope 声明(ADR-0011 D3/L0 语义位;字段可空,冻结前必须预留)
  modules: [kernel, cli]              #   module key 级 —— 必读集计算的主轴
  productLines: [PLT-TaskTree]        #   product-line 级(泽宇 2026-07-02:重要);vertical 轴不设——单仓单 vertical,YAGNI
proposedBy: { kind: agent, id: claude }
proposedAt: 2026-06-16T03:11:00Z
arbiter:   { kind: human, id: ZeyuLi } # 裁决者,必须 ≠ proposedBy(防自证)
decidedAt: 2026-06-16T04:02:00Z        # accept/reject/defer 时写
provenance:                            # 原文溯源(doc 44);task 也共用此结构
  - runtime: claude-code               # agent runtime
    sessionId: 88833871-9d1c-...       # 该 runtime 的 session id
    boundAt: 2026-06-16T03:10:00Z      # 绑定时刻 —— 必填,用于在滚动 session 里回溯定位"当初那段"
question: 内核是否应以 task 为唯一元语?  # 这条决策回答的问题
chosen:                                # 决定了什么策略
  - id: CH1
    text: 内核 = decision/task/fact 三元语,decision 为脊梁
rejected:                              # 否决了什么策略 —— 与 chosen 同等一等,不是可选
  - id: RJ1
    text: 继续以 task 为唯一元语,lesson 留作 task 子文档
    why_not: lesson 无消费者,只产不消,记得越多毒越深
  - id: RJ2
    text: 新增 facts/ 顶层文件夹,fact 脱离 task 独立存储
    why_not: fact 失去 provenance(哪个 task/commit/负载)即不可信
claims:                                # 承重论点(覆盖度查询的锚点);无 supportedBy 字段
  - id: C1
    text: lesson 缺消费者是 loop 闭不上的根因
relations:                             # typed relation records;不是 evidence_refs 自由数组
  - relation_id: rel_01K7Z...
    source: decision/<decision-id>/C1
    target: fact/<task-id>/F-a3f2
    type: supports
    strength: strong
    direction: directed
    origin: declared
    rationale: C1 is supported by measured finding F-a3f2.
    state: active
fingerprint: sha256:...
---
（正文:摩擦过程、讨论叙述 —— 非权威,人可改,不进图)
```

Validation:

- `state` 仅枚举值;`proposed→{active|rejected|deferred}`,`active→retired`,非法跃迁 gate 红。
- `arbiter.id ≠ proposedBy.id`(承重决策);否则 `decision_self_arbitration` 警告。
- **`rejected` 必填且非空**(承重决策)：决策的语义 = 选定一个策略**即否定其他策略**;只记 `chosen` 不记 `rejected` 等于丢失决策一半信息,使未来无法复现"当时为何排除"、导致同一否决被反复重做。`why_not` 每条必填。
- `claims[*]` 的支撑关系不写成自由 `evidence_refs` 数组,必须写成 typed `entity-relations/v1` records(§9)；覆盖度由 `RelationGraphProjection` 从 relation records 算可达,非此处 join。
- `riskTier` 缺省从 spawning decision 继承;顶层决策必须显式。
- **`riskTier` 与 `urgency` 是正交两轴**(doc 44):riskTier=风险/重要性→评审深度;urgency=紧急→排队顺序。不得用一个字段同时表达两者。task 的两轴默认从 spawning decision 继承,可覆盖。
- **`provenance` 必填且 `boundAt` 不可省**:每个元素 `{runtime, sessionId, boundAt}`;原文存 `harness/sessions/<sessionId>.md`(集中、不 gitignore、滚动覆盖为最新全量),不进 projection,仅供追溯。导出由 coordinator 在 entity 创建时自动完成(非 skill 步骤),task/decision 同此结构。
- 承重结构化字段全部在 frontmatter;正文不进 projection。

## 9. Entity-relations schema（泛化 task-relations/v1;出处 13 E42/E44、02 §4）

typed relation record(有身份的一等记录,**非独立文件**——住 source 实体 metadata,见下 M3 canonical 段),**边不能退化成普通字段或正文引用**(C2:Relation 是一等 typed edge entity)。`task-relations/v1` 泛化为 `entity-relations/v1`。

Relation 是 authored edge record: 有 `relation_id`、schema、state、rationale 与 origin,但不是 lifecycle package,也不是 M3 图里的 node。M3 图节点仍是 task / decision / fact；Relation record 只产生 edge。若未来需要引用边本身,另加 `relation/<id>` ref,不要把 relation 混进 `EntityRef` endpoint set。

M3 v1 canonical authored storage: relation records live in the source entity's structured metadata, under a typed `relations:` array. "一等实体"在这里指有 ID、schema、校验与投影身份,不等于一条边一个 Markdown 文件。`.harness/generated/*` 和 SQLite projection 是可重建视图, never the source of truth. **只有 typed relation records 的 `source`/`target` 产生图边**；普通 EntityRef、正文引用、旧 task-local `relations.md` 或 `evidence_refs` 均不得被当作权威边。Standalone `harness/relations/` package/root defer 到确实需要 relation 独立生命周期、高 fan-out 或外部导入流时再裁决。

```yaml
relation_id: rel_9f2c4a1d7e3b8c05       # 确定性内容派生(E61):rel_ + sha256(canonical(source|target|type|direction)) 短后缀;非随机签发
source: decision/<decision-id>/C1       # <entity>/<id>[/<claim|anchor>]
target: fact/<task-id>/F-a3f2           # <entity> ∈ task|decision|fact(+ 02 §4 既有 kinds)
type: supports                         # supports|supersedes|derives|blocks|relates|implements|...|invalidated-by|supersedes-fact
strength: strong                       # strong 参与 gate;weak 只导航
direction: directed
origin: declared                       # declared|imported_snapshot|generated|inferred
rationale: C1 is supported by the measured finding F-a3f2.
state: active                          # active|deprecated|deleted
```

> **落盘格式(E52)**:上述 record 以**单行 flow 式**写入 owner frontmatter(`- {relation_id: ..., source: ..., target: ..., type: ..., state: ...}`),多行 block 式禁用——依据见本节末"并发写入与合并语义"。

Validation:

- **`relation_id` 确定性内容派生(E61,2026-07-02 泽宇裁决)**:`rel_` + `sha256(canonical(source|target|type|direction))` 短后缀(16 字符级,精确长度/编码由实现 packet 定),**不随机签发**——同一条边任何分支复算一致,E52 的"相同边自动收敛"因此字面成立。`rationale`/`strength`/`state` 不进身份:同边属性分歧 → 同 relation_id 两条记录 → 下条唯一性检查红 → 人裁(即 E52 期望行为);属性若入哈希会让同边双写静默双计覆盖度。
- `relation_id` 在 authored root 内全局唯一；同一 relation record 不得在多个 entity metadata 中重复出现。唯一性检查同时兼任"同边属性分歧探测器"(见上条)。
- `source`/`target` 形如 `<entity>/<id>`,可带第三段锚到 claim 或 fact 短 ID(`decision/<decision-id>/C1`、`fact/<task-id>/F-a3f2`)。
- fact 的 EntityRef 规范为 `fact/<task-id>/<F-id>`;resolver 映射到对应 task 包内的 findings/progress/lesson_candidates 表行。fact 锚用稳定短 ID,**不用行号**(行号随上方编辑漂移)。
- Relation endpoint kind 只允许 `task|decision|fact`;Relation 自身不作为 M3 图遍历 endpoint。
- `type=supports` 的边:source 必为 decision(或其 claim),target 必为 fact —— 它就是覆盖度/风化判定的边。
- `type=invalidated-by` / `supersedes-fact` 的边(E49):表达 fact 失效(新 fact 或 decision → 旧 fact);fact 自身无状态机,失效全靠这些边表达,风化查覆盖度时顺其判定 fact 是否仍"活着"。
- `strength=strong` 或 `type=supports|blocks|supersedes|supersedes-fact|invalidated-by` 时 `rationale` 必填且非空；这是 Evidence Rationale 的唯一结构化落点,不得退回 decision `evidence_refs`。
- `origin` 表达边来源类别；relation record 继承其所在 entity 的 `provenance[]`。若未来将 relation 独立成 package,再为独立 relation package 增加自己的 provenance。
- 全图/闭包/入边由 `RelationGraphProjection`(SQLite,索引查询)生成,agent 不手维全图;高频**图导航/展示**查 projection,禁止手搓 Markdown 全图遍历。**承重的覆盖度/liveness gate 不在此列**——走本节末的"rebuild 到当前 SoT 再查新鲜 projection",不吃可能 stale 的 projection。
- EntityRef.kind 扩展 `decision`/`fact`(02 §4 已含 `finding`/`progress` 与 `| string` 逃逸,扩展兼容);M3 endpoint set = `task|decision|fact`。

**⚠️ 落地执法(红队 B6:上述规则须有代码,非仅文字)**:M3 实现时,投影 rebuild / `npm run check` **必须**校验以下三条,否则规则形同虚设:
- **host==source**:relation record 必须住在其 `source` 实体的 metadata 里(边"属于 source")。record 被误填进 `target` 或第三方实体 metadata → 报错;否则会继承错的宿主 `provenance`(§8 已警告 provenance 同名不同义)。
- **relation_id 全局唯一**:rebuild 时维护已见 relation_id 集合,重复 → 报错;防两个实体各声明一条互指边导致图中重复边、fan-out/覆盖度**双计**。
- **provenance 继承校验**:relation 的 provenance = host==source 实体的 `provenance[]`;host≠source 时该继承为错,由上一条拦截。

**⚠️ liveness/覆盖度读 SoT(红队 B1/B3,呼应 ADR-0008 D5)**:`invalidated-by`/`supersedes-fact` 改的是**旧 fact(target)的死活**,而 authored 按 owner 落盘只给**出边索引**——"这条 fact 还活着吗"是**入边查询**。承重判定(覆盖度 gate、fact liveness、删除 refuse-if-referenced)**必须基于当前 SoT:gate/删除前强制 rebuild 边表到最新、再查新鲜 projection**(既非手搓 Markdown 全图遍历,亦非信可能 stale 的 gitignore 边表;`git pull` 拉入新入边、rebuild 前边表漏边 → 误判)。**与 :277"查 projection"不冲突:冲突的是 stale、不是 projection 本身——承重路径查的是 rebuild 后的新鲜 projection**。未 rebuild 的边表仅加速非承重图导航。

**⚠ 并发写入与合并语义(E52/R3 实测,2026-07-02)**:
- **record 单行 flow 式落盘(格式约定,coordinator 出稿强制)**:实测多行 block 式 record 间有公共行(`state: active` 等),git 行级 merge 会把两条 record 拦腰交错,人工解冲突极易产出畸形 record;单行式下每条 record 是 git 合并的原子单位——两分支加**相同**边自动收敛为一条(内容即身份,零协调;E61 后 relation_id 也是内容派生,同边两侧整行字节一致,收敛不再依赖任何 ID 协调),加**不同**边冲突时两侧各为完整 record,解决=保留双方两行;同 relation_id 真属性分歧照常冲突并 surface 给人(这正是要的行为)。
- **冲突标记前置预检(执法触发时机,R3 终审裁定,E52 泽宇 2026-07-02 已批)**:relation_id 唯一/host==source/provenance 三条执法依赖 check 被执行,而 merge 不会自动跑 check——填法:把冲突标记扫描(复用 `post-merge-checks.ts` 的 `findConflictMarkers`)前置到所有 CLI 写命令与 status/list 入口做廉价预检(`^<<<<<<<` grep),命中即提示先解冲突;git hook(不随 clone 分发、可 --no-verify 绕)与 CI-only(本地无 CI)均否。真分歧由人解;`fix relations` 自动语义合并(pnpm 模式)defer 到多人高频冲突真实出现。
