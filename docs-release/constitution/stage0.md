# Stage0 Manifest v1 —— 三元语组织宪章

- 版本：0.3.0-draft-v2 · 2026-07-26 · 内容钉见 `docs-release/constitution/stage0.pin`
- 立宪授权：dec_01KYEMDBN9JM5KST6BR4EQGJ46（冻组织不冻结构）
- 成稿方式：多模型盲写合成+穷尽判例审计，过程档案在私有台账。
- 一句话：**本宪章声明让这个系统"成为它自己"的那组不变关系（组织）。实现（结构）可整体替换；宪章各条仍成立，系统就还是它自己。**

## §0 判据、冻结语义与自反条款

- 收录判据（Autopoiesis）：**移除此条后，系统还是不是"它自己"？** 不是⇒收录；仍是（只是更差）⇒逐出。
- 冻结的是规则关系，不是任何实现。重写、换语言、换存储合法——只要 §10 的重建测试仍全绿。
- **自反条款**：组织条款的增删改只能走 §11 修宪路径；任何 feature/迁移/修门**不得顺带改组织**。实现与宪章冲突时：要么拒绝实现，要么显式修宪。（22 次写路径翻修没有一次问过宪法——这正是立宪的直接起因。）
- **适用域**：本宪章是本系统自身的组织宪法。使用者用本系统是为了完成**他们自己的**工作，不是为了开发本系统——因此宪章只约束系统必须向使用者提供的关系（归属可追、真相可审、回执诚实、评价权归属清晰），**不规定使用强度**：完成门、评审重量、流程厚度全部由 preset/profile 在结构面声明（§12 evaluatorOwnership），轻用途完全合法。系统的宪法义务是让问责成为使用者的地基而非负担（§1 注意力守恒）。

## §1 目的与身份

- 系统身份：**人与 agent 共存的社会性问责系统**——让每一次承重工作留下可被下一次运行无歧义消费的轨迹，把"完成"从自信声明变成可验证的结构态；主体性三要件 = 权限 + 责任 + 可追之痕；治理靠制度不靠监视（dec_mrghr2br）。
- **注意力守恒是三元语的目的面（与三原语一体两面，项目 owner终审收录）**：三元语存在的理由是让人在事件量几何增长时保持有界的关键注意力——拨开全部事件找到承重本质，正是为了注意力守恒。任何扩展若使人的必读面随事件量线性增长，即违背本条（锚 dec_mrg1dl9z）。
- dogfood 是身份循环的自证：DECIDE→WORK→VERIFY→LEARN，本系统自身的开发走同一套。

## §2 三原语与血管

1. 承重认识论原语**恰好三个**：decision=WHY（承重、可反驳的选择）、task=WHAT（有边界可流转的工作责任）、fact=IS（有来源、不可原地改写的观察）。三者正交不可互相冒充：状态声明不是事实，交付物不是自动成立的事实，review verdict 不是塑造未来的 decision。
2. Execution/Review/Consent/Session/Signoff 等可以成为**一等实体**，但它们是执行、评价、授权结构，**不是第四认识论原语**（对 dec_mrg1fces 的兼容解释：一等结构≠新原语）。
3. relation 是血管：每条边必须 **typed + 显式声明 direction（directed 或 undirected）+ 有来源 + 有生命周期**，authored 形态锚定在拥有者实体内，端点必须解析到真实身份，(source,type,target) 走封闭三元组白名单。代谢、覆盖度、影响面定义为图上可达性问题，不靠目录邻接或 agent 记忆。
4. fact 寄居出生地（产出它的 task），跨任务地位靠**被 decision 引用**获得，不靠搬家。

## §3 真相与历史

1. 承重真相活在**人可 diff/blame/逐行评审的 authored git-markdown**：frontmatter/schema 承重（机读权威），正文人读不承重；DB/索引/缓存/GUI 恒为派生投影，**可整体删除并从 authored history 重建**，禁止任何形式的共同真相源。
2. 仅因时间流逝而变的运行态（lease/holder/心跳）不得写成 authored 真相；归 runtime authority 管理，另留审计事件。
3. 同一契约存在多个消费形态时必须指定**唯一权威源**，其余派生；手工镜像+事后一致性测试不合格（dec_LEDGER_E55）。边缘层（CLI/GUI/daemon）不得自带业务谓词或第二状态机，语义判断单点在 kernel（dec_LEDGER_E54）。
4. 一切 canonical mutation 经**唯一写权威边界**：效果前验证（状态/关系/授权/并发），未知即拒绝（fail-closed）；接受则原子、耐久、恰好一次；**回执必须精确对应已落盘的效果**。绕行产物一律判幽灵。
5. 历史 append-only：台账 trunk 禁改写；承重断言的更正只能**加法式**——署名撤回/降级并永久保留原文与理由（dec_HONEST_CLAIM_CORRECTION）；签字必须钉住被签内容的不可变摘要，事后 amend 不影响已签快照（dec_mrg9qxej）。
6. 身份稳定：每个实体与关系有全局唯一、永不复用的 ID；路径与仓别名只是路由（dec_mrg9r6j7）。组织结构（部门/汇报线）是带时效的关系与路由，不入本体，重组不改写历史归属（dec_mrg9qofk）。
7. 外部 memory/召回系统恒为可删投影，不得成为第二事实源或旁路写道（dec_LEDGER_E64、dec_01KYEMF948714VSF90P0CGDSZX）；自动蒸馏产物只是 candidate，晋升为 fact 必须显式动作（dec_LEDGER_E65）。
8. **台账与代码分仓（项目 owner终审入宪）**：台账属于其 owner，独立于被管控的代码仓，单 canonical 副本、禁 worktree 分叉；代码 PR 不得夹带台账内容（dec_LEDGER_E8、dec_mraja5we、dec_HARNESS_LEDGER_NO_WORKTREE）。公开/私有的分界由部署者选择——本项目自身的实例形态是代码公开+台账私有。移除此条即破坏真相载体的所有权边界与单副本性。

## §4 归属与主权

1. 每次承重写记录**事件级双轴归属**：principal（承担责任的**人**）+ executor（实际执行的 agent 或空=本人直接操作）；append-only 不可改写；实体上的"谁"只能是事件历史的投影（dec_mrd7jiux）。
2. principal 必须由**可信边界作证**（传输层/凭据），客户端与环境变量不得自报——env 无法作证人在场是范畴错误而非配置错误（dec_mrczk07e）；无法作证时 fail-closed，历史空洞标 unresolved 而非伪造。
3. agent 可以署名、可以担责，但任何 agent 的权责链**必须回溯到一个 responsibleHuman**（dec_mrcdaaq8、dec_mrdrbkp7）。
4. **最终主权在人，不可转让**；逐项裁决可以制度化委托给 gate 或 agent，但每次委托必须作为 decision 入账、范围化、可收回（dec_mrg1ffm1）。agent 代人执行批准动作是常态且合法——敲 CLI 的手可以是 agent，主权锚在授权链上。
5. **自我闭环禁令挂在 executor 轴**：人可自批，agent 互批合法（A2A 依赖它），唯一禁止 = 同一 executor 自提自判（dec_01KXCHW9MFV8E3QGZJJW91YNDS）。

## §5 评价与完成

1. 提交是**完成主张不是完成证明**：最小提交包必须含交付物、证据引用、验证说明、**已知缺口与残余风险**（强制字段）。
2. 机器只裁它能诚实知道的：身份、引用存在性、digest、状态转换、授权、receipt；**"本轮交付是否成立"的语义评价独占于 Reviewer**，机器不得伪装会判断相关性/正确性/充分性（dec_mrg3z1we）。
3. 三权分离：Worker 止于 submit；Reviewer 只裁单轮交付，方向问题唯一出口是 propose decision（不得夹带在 verdict 里）；complete 由 Commander/CEO 在门后原子执行。终态由门达成，不由自称达成。
4. accept 是判断门（证据下限或显式 judgment-only），reckon 是覆盖门（承重 claim 沿图可达活证据，一生健康分）——两门分离（dec_F2_ACCEPT_RECKON）。
5. **task 轴纯机械，人的判断重量只落在 decision 轴**（dec_mrca9hx4）；聚合/rollup 只能提示收口，不得自动伪造完成或 verdict（dec_mrdog2z5）。
6. 已 accept 的 decision 不得成为死文字：必须派生 implements task 或显式 defer（dec_GOV_MILESTONE_SCOPE_TASK_DERIVATION）。

## §6 门与治理

1. **门三要素同一性**：执法体、规则源、被执法面必须内容寻址绑定为同一份真相；一切"新鲜度代理"（mtime/陈旧构建/文档代执法）视为缺陷。每道门必须有**阳性对照**证明它能出声——信任沉默之前先让它叫（dec_mrdtjib3、dec_GATE_DEFENSE_ROOT_CAUSE）。
2. gate 权威从**消费图**派生，不从 producer 自报；被检查者不得在自己的修改半径内改写检查自己的权威面（dec_CI_GATE_AUTHORITY_MODEL）。
3. **治理受治理**：新治理构件默认记为负债，后验净改善才转资产；净值判据=给诚实者的摩擦不得大于给作弊者增加的成本（dec_01KYEMFXCPEBBH7CD2CCDWNX1B，standing policy）。
4. 机械防御只防意外不假装防作弊；治理靠**事后可追责**，不靠过程监视（dec_LEDGER_E50）。

## §7 代谢

1. **双向代谢是组织**：正向（fact→提议→裁决→派生→执行→新 fact）与逆向（失去支撑→触发复核；supersede/retire→反向标记引用者需重读）缺一即腐（dec_LEDGER_E37）。
2. **退役而非遗忘**：归档=留公理降定理，不再默认召回但可回；历史可以降温，不能伪装仍有效，也不能靠摘要销毁出处。
3. **采用律（强形式，项目 owner终审入宪）**：能力、记录或索引只有成为某条承重路径的**唯一合法入口**并被持续消费，才算被采用；生产者-消费者闭环（持续生产的记录/功能在计为完成前必须有真实消费者与可调用读面，无消费者只能登记 deferred/spike，dec_GOV_PRODUCER_CONSUMER_CLOSURE）是其派生弱形式。未被采用的构件在代谢上视同负债。

## §8 内核最小性

- kernel 只定义稳定实体、槽位、写协调、投影边界；领域形状由 vertical/preset/template 外层叠加，**永不上升为内核本体**；vertical 通过声明加入，不通过改 kernel 状态机加入（dec_LEDGER_E16、ADR-0019）。

## §9 bootstrap / restore

- daemon 与投影**不拥有** authored 真相；从台账 + 版本匹配的程序与本宪章，可重建全部语义状态（较 v0 收窄：不再声称"台账+宪章足以"，恢复还需可执行代码与配置——审计反向检查第 4 条）。
- 替代实现自称同一系统的最低试验：①从 authored history 重建全部实体/状态/关系/签字/归属；②随机删投影后语义等价；③对非法转换、悬空边、自我闭环、伪 human 归属、陈旧门、冲突写逐项 fail-closed；④中断写重放恰好一次生效。

## §10 重建测试（宪章自验）

1. 机械对账：`tools/check-stage0-manifest.mjs` 校验 §12 machine 块与 kernel 域源码一致 + 内容钉一致。
2. 零记忆重建测试（接冷启动门 dec_01KYEMCYK0KAKB0JNW9XV199C1）：零前情 agent 只读本宪章与公开文档，须能答对：三原语与其分工、什么被禁止、投影坏了怎么办、谁拥有语义评价权、责任链落在谁身上。

## §11 修宪协议

修宪 = 提出 content-pinned 宪章级 decision（逐条说明旧条款为何不再决定身份、替代关系如何闭合）→ 具最终主权者（项目 owner）裁决 → 改文 → 更新 pin → 核验器复绿 → 附零记忆重建测试复跑。

## §12 machine 块（钉住的结构面——核验器消费）

```yaml
stage0:
  version: 0.3.0-draft-v2
  primitives: [decision, task, fact]
  relationTypes: [supports, supersedes, refines, narrows, derives, blocks, relates, implements, depends-on, produces, evidences, evidenced-by, refutes, invalidated-by, supersedes-fact]
  relationDirections: [directed, undirected]
  taskStatuses:
    open: [planned, active, blocked, in_review]
    terminal: [done, cancelled]
  decisionStates:
    all: [proposed, active, rejected, deferred, retired]
    terminal: [rejected, deferred, retired]
  authority:
    principal: transport-derived-person
    taskWrite: holder-lease
    selfLoopBan: same-executor-propose-and-judge
    dispositionLowerBound: true
  evaluatorOwnership:
    completionGates: preset-derived
    semanticSufficiency: reviewer-only
    candidateMayModifyEvaluator: false
  restore:
    ssot: git-markdown-ledger
    projectionsRebuildable: true
sources:
  relationTypes: packages/kernel/src/domain/entity-relation.ts
  relationDirections: packages/kernel/src/domain/entity-relation.ts
  taskStatuses: packages/kernel/src/domain/lifecycle-status.ts
  decisionStates: packages/kernel/src/domain/decision-lifecycle-status.ts
```

---

*v1 相对 v0 的实质变化：修正 2 处与判例的冲突（自我闭环挂 executor 轴；边方向允许 undirected）；并入审计 35 条遗漏中的 28 条（主权/双轴归属/签字钉内容/Reviewer 独占/唯一权威源派生/身份稳定/双向代谢/append-only 更正等）；收窄 1 处过度断言（§9 restore）；其余 7 条遗漏经判据复核归入结构面或运营层；5 处盲写分歧上交终审（过程档案在私有台账）。全部证据在私有台账。*
