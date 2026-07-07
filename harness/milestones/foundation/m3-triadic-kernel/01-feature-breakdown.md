# M3 · Feature Breakdown

- **状态**: planned
- **日期**: 2026-06-25（2026-07-01 按 ADR-0008/E51 扩展 packet）
- **来源**: `00-overview.md`;`10-foundation/41/42/43/44/45`;`ha decision list --legacy-range E35-E51 --compact`;`harness/contracts/18-schema-contracts-and-validation.md` §8/§9;**`harness/adr/ADR-0008-generic-entity-framework-and-substrate.md`**（通用实体框架 + substrate 立场 + D8 通用 Executor）

## 0. 2026-07-02 开工前增量（M3 前置边缘层加固 T1-T7 / PR #83-#95 合入后核验，全部 worker 必读）

对源码逐条核验后，M3 的骨架设计与 packet 拆分**不变**；以下增量修正过期引用并追加新 gate 约束（同步收录于 `m3-coordinator-context-pack.md` 加固后约束节）：

1. **T6 设计输入（E62）**：six-point 包 T6 产物 `tasks/task_01KWGNHC2PZV62QC4DH12QE7VJ-t6-relation-read-model-portable-path-m4-design/artifacts/relation-read-model-portable-path-design.md` 是 **TP-02/03a2/05/06 的必读设计输入**（EntityRef 文法、ingestion 管线、typed projection 表草案、fact anchor 语义、@effect/sql 同批落地建议）；与 canonical 冲突时以 18 §9/E52/E61 为准。留 M4 的只有：portable-path typed 化、`relations.md` 废弃收口、跨 harness resolver、GUI graph 消费端。
2. **relation_id 确定性派生（E61）**：`rel_` + `sha256(canonical(source|target|type|direction))` 短后缀，不随机签发；rationale/strength/state 不进身份。TP-02 实现按此。
3. **CLI 命令 = 描述符模型（ADR-0012/0013，TP-04 工作面变化）**：加命令组现在要同步 8 个强制触点——`command-registry.ts` 的 commandUsages/commandParserIds/commandRunnerIds/commandSummaries/commandExamples、`receipt-contracts.ts`（commandReceiptContractsByKind）、`error-codes.ts`、`runner-registry.ts`——外加 `tools/check-cli-help-contract` gate 与类型级 `satisfies` 穷尽（漏一处编译红）。"parser registry 加命令组"的旧口径作废。
4. **decision 状态语义复刻加固分层（ADR-0012 模式，TP-01/03b/04 约束）**：`proposed|active|rejected|deferred|retired` 的转换合法性表放 kernel domain（类比 `lifecycle-status.ts:explainStatusTransition` 单一权威），op 编排放 application（类比 `task-lifecycle-orchestrator.ts`），CLI runner 只消费结果。**禁止**把转换判定写进 CLI/adapter；G1 禁符 gate（`tools/scan-forbidden-symbols.mjs`）随 TP-03b 增补 decision 侧条目。
5. **G7 orphan gate 已扩全仓（T7）**：`packages/**/src/**` 新模块同变更集无真实消费者（barrel re-export 不算）会被 `check-import-boundaries` 卡红；先行落地的 schema/resolver 模块必须加 `@slice-activation` 头注释豁免并在后续波次移除。wave 0 的 TP-00r/TP-01/TP-02 直接命中此约束。
6. **watermark/opId 机制已迁移**：原 `task-writes.ts:49` 的 opId 生成已抽到 `packages/kernel/src/write-coordination/write-helpers.ts:51`（`hashPayload(taskId|kind|payload)` + `opIdPrefix` 参数，PR #93 为 EntityId 泛化留了口）。TP-03a/03b 从这里出发，成本比原估略降。
7. **测试与边界纪律**：新增测试文件必须登记 `tools/test-tier-manifest.mjs`（fast/contract/integration 三档）；Vitest/ESLint 边界遵 ADR-0015。
8. **E59 seam 已裁**：TP-03a 泛化 WriteCoordinator 时不得顺手动 `LifecycleEngine` port（rename 为 SnapshotEngine 归 M4 实施包，须按 E13 端口准入规则整变更集走）。

## 1. Packet 候选

| Packet | 目标 | 主要产出 | Exit evidence |
| --- | --- | --- | --- |
| TP-M3-00a 实体清单回写 (Sweep) | **前置**: 补齐 02/34 回写，防止开工时 canonical 冲突 | 并入既有 sweep `task_01KV85WNQ57CRBPGS78RBA1CAG`，将 Decision/fact 写入 02 实体清单和 34 架构图 | 02 §1/§2/§4 含 Decision/fact 与 EntityRef 扩，34 架构图更新 |
| TP-M3-00b Entity Extension Contract | 让声明机制从"只通 task"扩到 decision/fact,且双层(约定检测结构 + 最小声明意图) | 给 `vertical.json` 的 entityKinds 接入 decision(lifecycle) 与 fact(schema);消除现有 scaffold/selection 冗余;composite/milestone 不在 M3 做(E50/SLIM-5) | coding vertical 能声明式定义 decision/fact,不改 kernel 代码;结构非法 fail-closed 报错;旧 vertical.json 冗余被约定吃掉;不引入 composite 框架 |
| **TP-M3-00c EntityKind 注册表 + repositoryScaffold + vertical 脚本声明位**(ADR-0008 D7 / 契约 40) | **新增**:"加实体 = 加一条 schema 声明 + root resolver",不硬编码新 WriteOpKind/新表/新 check;定义 vertical 的仓库级骨架层;**并定形 TP-00d 契约的声明面落点**(vertical/user 级脚本在哪声明) | 薄 EntityKind 注册表(Effect Schema 声明 + entity-root resolver);vertical-definition/v2 加 `repositoryScaffold`(dirs + seededDocs,如 ADR 目录+示例模板),与 packageScaffolds(包内)正交;**vertical-definition/v2 加 `scripts[]` 声明位**(承 `40-script-execution-contract.md` §2 的 scriptEntry:id/command/reads/writes/metadata),与 user 级脚本注册一并定形——preset 脚本走既有 entrypoints[type=script];**TP-11 骨架物化合并入此**(entity-root resolver + lazy mkdir,init.ts 去硬编码);**init 内联文档模板一并吸收(2026-07-02 回写,ADR-0016 D5/issue #80)**:AGENTS.md/CLAUDE.md/repo-governance.md 脚手架文本从 init.ts 内联字符串迁入 seededDocs 模板资产(locale 化,builtin/user/project 层叠),#80 只补边界一句话不做搬迁;"骨架非实体"原则写进注册表;消除 SLIM-6 顶层 templateSelections 与 packageScaffolds 冗余 | 加 decision/fact entityKind 不改 kernel 写路径代码;coding vertical repositoryScaffold 含 decisions/sessions/adr 骨架声明;coding vertical `scripts[]` 可声明如 `vertical:adr-seed` 且被 `harness script list` 发现;init 读 repositoryScaffold 物化,不再硬编码目录与文档模板文本;template 叠加语义(vertical⊕preset⊕capability 按 slot 合并)有测试 |
| **TP-M3-00d 通用脚本执行宿主 ScriptHost**(ADR-0008 D8,M3 靠前) | **新增**:"非 Kernel 能力不写死在仓库代码里"的地基——把 `preset-script-runner` 泛化为内核级通用 Executor | sandboxed 子进程 Executor(非 parser,复用 Node `--permission`);去 preset 绑定,vertical/preset/repositoryScaffold 都经通用扩展点调它;正式 `script-contract`(输入/输出/结构化错误/脚本元数据,**已细化见 `harness/contracts/40-script-execution-contract.md`**);`harness script list/inspect/run` 通用门面;回传通道走 `.harness/script-runs/`;**写作用域放宽到整个 harness 骨架**(放宽 `preset-script-runner.ts:62` 的 task-outputRoot 锁定);ADR seeding/骨架物化/自动编号降级为消费者脚本,内核零专用代码 | ScriptHost 从 preset 抽离为 kernel 级;脚本契约不合规 fail-closed;`harness script list` 消费 metadata;消费者脚本可写 adr/ 等骨架子目录;安全边界(写面扩大)有意放宽、defer COM 收紧(见 ADR-0008 C 段) |
| TP-M3-01 Decision Schema And Fixtures | 把 `decision-package/v1` 从设计落成可校验 schema | TS/Effect Schema、JSON Schema、golden fixtures(valid/invalid);state 枚举简化(跳过 accepted, `proposed\|active\|rejected\|deferred\|retired`);`rejected` 非空 + 每条 `why_not`、`arbiter≠proposedBy`、`riskTier`/`urgency` 两轴、`provenance[]` 校验;`chosen/rejected/claims` 提供稳定 anchor ID;不引入 `evidence_refs` 边数组 | schema contract test 全绿;空 rejected fixture 触发 invalid;非法 state 跃迁被拒;proposer=arbiter 触发 invalid/warning;chosen/rejected/claims anchor 可被 relation 文件引用;不要求高 riskTier + agent arbiter fixture 失败 |
| TP-M3-02 Entity-Relations Schema | 泛化 `task-relations/v1` → `entity-relations/v1` | `source/target = <entity>/<id>[/anchor]`;type 集 supports/supersedes/derives/blocks/relates/...;EntityRef.kind 扩 `decision\|fact`;authored 边记录是 source entity metadata 里的 typed `relations:` record;`origin` + `rationale`;schema + fixtures;**relation_id 确定性内容派生(E61)**;**设计输入=T6 artifact(E62,§0 增量 1)** | task/decision/fact 三类 endpoint fixture;relation record 解析测试;rationale 空字符串 fixture invalid;同边不同属性 fixture 触发 relation_id 唯一性红;projection 只从 typed relation records 产边;**不兼容读取旧 task-relations，直接废弃并迁移** |
| TP-M3-03a WriteCoordinator 泛化 | WriteCoordinator 端口与实现从 TaskId 泛化为 EntityId | WriteOp 标识改为 `entityId: EntityId`，kind 支持 `TaskWriteOpKind \| DecisionWriteOpKind`; 原有 10 个测试统一为 Entity parallel test;**WriteOp 接口预留 `provenance?: ProvenancePayload` 可选字段(D-01)**,避免 TP-08 时二次重构;依赖 TP-03a2 spike 结论确定 EntityId 形状 | 泛化后现有 task ops 与 coordinator 的 parallel entity 测试全绿;WriteOp 接口含 provenance 可选字段 |
| **TP-M3-03a2 @effect/sql 读模型采用**(ADR-0008 D4) | **新增**:把手搓 `node:sqlite` 投影换为 `@effect/sql` SqlClient+Model,一步解决脆弱+PG 迁移+Mapper | spike 验证 `@effect/sql`/`-sqlite-node`/`-pg`/`Model` API 面;SqlClient 作 Context.Tag,消费者只认它;PG 留 Layer 替换;迁 `sqlite-projection-store.ts`/`sqlite-task-source.ts` 到 typed repository;watermark/opId 机制不变 | spike 报告确认 API 面;投影读写经 SqlClient;`-pg` Layer 可替换性验证;现有 projection contract test 全绿;**spike 先行,解锁 03a/06**;**时机判断遵 T6 artifact §7:spike 过门则 typed 表与 @effect/sql 同批落地,fallback 则先 node:sqlite 保 contract(E62)** |
| TP-M3-03b Decision Write Ops | decision 封闭 op 集进 coordinator | `WriteCoordinator` 加 `decision_propose/accept/reject/defer/supersede/amend/retire`;复用 watermark/journal/lock 机制;落 `decisions/decision-<id>/decision.md`;decision 落盘时在 frontmatter 注入 `_coordinatorWatermark` = coordinator 签发的 per-entity opId token;不做 SHA-256 内容重算(E50/SLIM-4);accept 校验 proposer≠arbiter,但不按 actorClass 强拒;**decision 状态转换合法性表放 kernel domain、op 编排放 application(§0 增量 4),G1 禁符随本包增补** | 每个 decision op 的 journal idempotency test;crash-before-watermark 对 decision 同样恢复;proposer≠arbiter 在 accept 时校验;无 watermark / 重复 watermark 被 check 报错且 projection 跳过 |
| TP-M3-04 Decision CLI Surface | 暴露 `harness decision <op>` 命令 | 按**命令描述符模型**(ADR-0012/0013,§0 增量 3)加 decision 命令组:commandUsages/parserIds/runnerIds/summaries/examples + receipt contracts + error codes + runner registry 八触点全部同步,类型级 `satisfies` 穷尽;`--help`(依赖既有 help contract);chosen/rejected/why_not/riskTier/urgency 入参;dry-run;转换合法性判定只消费 domain/application(§0 增量 4),不在 runner 里写 | `harness decision propose` 创建合法包;空 rejected 被 CLI 拒;`check-cli-help-contract` 与 descriptor 完备性 gate 绿;命令注册测试 |
| TP-M3-05 Fact Entity And Stable Anchors | fact 作为可引用一等观察 | task 包内**专属 fact 账本文档**承载 typed fact record(E58 2026-07-02:scaffold 自动创建,暂拟 `facts.md`,命名与 record schema 由本包定);CLI `record` 经 WriteCoordinator 单行 flow 式 append;事实短 ID 格式规范 `F-<8char-base32-ulid-suffix>`,自动生成且分配后不可变;fact 不出 task 容器;findings/progress 回归叙事面、可内联引用 F-id;lesson_candidates 是否并入账本在本包入场时细化(E58 ⑥);**设计输入=T6 artifact §3 owner-qualified fact ref 语义(E62)**;`npm run check` 必须含全量悬空指针扫描(Dangling Pointer Scan, INV-6;扫描面=账本单载体+叙事内联引用);不做 fact `_contentHash` / content-hash 链(E50/CUT-4) | fact 锚 `task_x/F-xxxx` 可被 relation 引用;锚解析测试;行号未被用作锚;悬空指针扫描测试:引用不存在 Fact ID → check 报错 |
| TP-M3-06 Relation Graph Projection | 把 relation 重建进 projection,支撑覆盖度查询 | 在现有 SQLite projection 基础上新增 relation 边表/查询;入边/可达/覆盖度查询(decision 承重论点 → 活 fact 可达);环安全复用并泛化现有 `findRelationCycles`;读时免疫只做 `_coordinatorWatermark` 存在性 + 全局唯一性,不做 SHA-256 内容重算(E50/SLIM-2/SLIM-3/SLIM-4);**设计输入=T6 artifact §5 typed projection 表草案(entities/anchors/facts/relations/coverage_rows + 索引,E62)** | 覆盖度查询在 projection 上可跑;rebuild 后图一致;高频查询不裸扫文件(查 projection);环路测试:构造 A→B→C→A 循环引用 → 检查正常发现并报警,不挂起不 OOM;幽灵测试:无 watermark 或重复 watermark 的 decision.md → check 报错且 rebuild 后不在 Graph 中 |
| TP-M3-07a CurrentSessionProbe Port | 解决 session id 获取问题，定义 CurrentSessionProbe | kernel 定义 port；CLI 注入；实现 4 个 runtime adapters (Claude/Codex/Zcode/Antigravity)；**必须支持 `human-cli-local` 回退**:当探针检测不到任何 Agent Runtime 时,降级为 `{runtime: "human", sessionId: "human-cli-<timestamp>", source: "manual"}`——抓取终端用户 `$USER`/时间戳作为 fallback 证据。**Schema 层面 provenance 允许 `runtime: "human"` 类型** | 4 个 runtime 均能正确探测当前 sessionId；**无 Agent 环境测试:在裸终端运行 CLI → 自动降级为 human session,不崩溃不报错** |
| TP-M3-07b Provenance Capture | provenance 原文导出器核心 | 复用 runtime 自带磁盘日志,移植 Claude/Codex 的 JSONL→markdown 渲染核心;Zcode/Antigravity 按 doc 44 §4 渐进补;不建 Harness 父进程 I/O Proxy,不做结构化分段/标注/摘要(E50/CUT-1,SLIM-1) | `harness/sessions/<sessionId>.md` 可由 runtime 磁盘日志生成并按 id 检索;导出失败有可见错误;无 `.raw.jsonl` 依赖 |
| TP-M3-08 Provenance Binding On Create | entity 创建时 coordinator 自动写 provenance | new-task / decision propose 落盘时自动调用 07a probe + 07b 导出器,写 entity `provenance:[{runtime,sessionId,boundAt}]`;不加 `rawSessionRef`(E50/CUT-2) | task 和 decision 都自动获得 provenance(无漏);boundAt 时间锚存在;按 id CLI 检索原文 |
| TP-M3-09 Decision Skills | 两个薄触发器 skill | `/decision`(提名当前对话段为承重节点)+ `/decisions`(走裁决队列,逐条对话式裁决);skill 只调 CLI 绝不写 markdown | skill 触发 CLI 成功;skill 不直接写文件(审查);v1 仅此两个 skill |
| TP-M3-10 Decision Write Visible Defense | decision 写绕过 coordinator 的一层可见防意外检查 | `npm run check` 扫描 decision frontmatter,缺 `_coordinatorWatermark` 或重复 watermark → 报错;Projection rebuild 同步跳过这些实体;不做路径正则、git precommit 钩子、SHA-256 hash 或四层防御(E50/CUT-3) | 手写无 watermark decision 与复制粘贴重复 watermark decision 均被 check 检出;projection 查询不受幽灵决策污染 |
| ~~TP-M3-11 Vertical-Materialized Skeleton~~ | **合并入 TP-M3-00c**(ADR-0008 D7):骨架物化是 EntityKind 注册表 + repositoryScaffold 的一部分,不再单列 | (见 TP-00c) | (见 TP-00c) |
| TP-M3-12a Self-Host Backfill (Create) | 自宿主验收 (实例回填) | 把 13 的 E45/E47 回填为真实 `decision-package/v1` 实例，provenance 指向本设计 session 原文 | E45/E47 成为真 decision 文件并可手工解析 |
| TP-M3-12b Self-Host Evidence Validation | 自宿主验收 (覆盖度验证) | 待 TP-06 完成后，对 TP-12a 创建的 decision 跑覆盖度查询验证 | 覆盖度查询可达 E45/E47 evidence |
| ~~TP-M3-13 Delete Semantics 泛化~~ → **defer 到 M4**(红队 D9/O-3) | 单人 dogfood 删除极低频,不值 M3 做;**INV-6 悬空扫描仍在 M3 保留** | (defer M4)删除守卫**每 EntityKind 一套 disposition**(非参数化,红队 B5);refuse-if-referenced **读 SoT 全扫**(非边表,红队 B1:边表 stale 会误删);无级联 | (M4)soft/hard delete 对 decision/fact 可用;删被引用 entity → 读 SoT 拒绝硬删 |

## 2. 依赖顺序(**对抗审查后重排:核心闭环先行,烂尾风险隔离到末尾**)

**波次视图(ADR-0008 后,详见 rollout plan §4;此处为梯队依赖):**

**第一梯队 — 核心 decision 闭环(self-hosting 最小切片,最该先做、最可能成功):**
1. **TP-00a**(前置 sweep):02/34 实体清单与架构图回写。
2. **TP-00b**(前置,doc 45):声明机制能表达 decision/fact/composite。
3. **TP-01 / TP-02**(并行):decision-package/v1 + entity-relations/v1 schema + fixtures。
4. **★ TP-03a2(先行 spike,ADR-0008 D4)**:@effect/sql API 面验证,解锁 03a/06 读模型。⚠️ **设时间盒+判定门+fallback(红队 D2 SPOF)**:不满足则退回 `node:sqlite` 投影(=原 M3),03a 用无 Model 的 branded EntityId 与持久化解耦,spike 成败都不返工。不 all-in 赌 spike。
5. **★ 最小 entity-root resolver(前置,红队 D1)**:从 TP-00c 拆出 entityId→路径映射,前置到此波次——TP-03a 的 applyOp 路径解析需要它,避免"第一梯队 03a 需第二梯队 00c"的反向依赖。
6. **★ TP-00d(先行,ADR-0008 D8,与 03a2 并列最先启动)**:通用 ScriptHost Executor 泛化,非 Kernel 能力地基。
6. **TP-03a 依赖 TP-01 + TP-03a2 + 最小 resolver**:WriteCoordinator EntityId 泛化。
7. **TP-03b 依赖 TP-03a**:7 个 decision op 进 coordinator。
8. **TP-04 依赖 TP-03b**:`harness decision <op>` CLI。
9. **★ TP-12a(提前到此处,不等全绿;rollout §4.1 列于"波次5"仅是编号靠后——依赖只有 TP-04,完成即可跑)**:把 13 的 E45/E47 回填为真 decision 实例(实例创建)。

> 第一梯队完成后,M3 已有可演示、可验收的核心价值(decision 闭环)。以下为外围/硬化,烂尾不影响核心。

**第二梯队 — fact/relation/provenance 支撑:**
10. **TP-00c 依赖 TP-01/02 + TP-00d**(ADR-0008 D7,含原 TP-11;**最小 entity-root resolver 已前置到第一梯队**,此处是注册表其余部分):EntityKind 注册表 + repositoryScaffold(骨架物化经 00d 消费者脚本)。⚠️ **三层模板叠加(vertical⊕preset⊕capability)defer(红队 D7)**:单 vertical dogfood 不需要,等第二个 vertical 出现再做。
11. **TP-05**(可与梯队一并行):fact 稳定锚规范落地。
12. **TP-06 依赖 TP-03a2 + TP-02 + TP-05**:RelationGraphProjection(建在 @effect/sql 读模型上,边表+可达+覆盖度+rebuild)。
13. ~~TP-13 删除语义泛化~~ → **defer 到 M4**(红队 D9/O-3);M3 保留 INV-6 悬空扫描即可。
14. **★ TP-12b 依赖 TP-12a+TP-06**:对 E45/E47 执行 semantic evidence 可达查询验证。
15. **TP-07a**:CurrentSessionProbe Port 及 runtime adapters。
16. **TP-07b**:conversation-mining 内化(覆盖 Claude/Codex/Zcode)。
17. **TP-08 依赖 TP-03b+TP-07a+TP-07b**:coordinator 自动写 provenance。
18. **TP-09 依赖 TP-04**:两个 skill。

**第三梯队 — E50 后不再派重型防作弊线:**
19. **TP-10 残余**:只保留可见 watermark 存在性 + 唯一性检查;可与 TP-03b/TP-06 合并实现。路径正则、git precommit、SHA-256 内容重算、I/O Proxy、fact content-hash、高 risk agent accept 强拒均不派 M3 packet。

> **ADR-0008 + 红队 R1 后的 M3 packet**:净 +3 落地(TP-00c/00d/03a2;TP-13 已 defer M4)。⚠️ **工作量诚实重估(红队 D3)**:原"34-42"低估——TP-03a2 是**重写**两个在跑 store(回归保持型最贵,5-8 人日)、@effect/sql 是**建**读模型非换轮子(现 row_json blob 无列),真实 **M3 ~40-50 人日**。TP-00d/03a2 不在关键链上(与 schema/spike 并行起步),不拖慢核心 decision 闭环。

## 3. 关键策略清单

### 3.1 核心语义策略(沿用)

- decision 复用 task 的 `WriteCoordinator`/watermark/journal/lock,**不重造**写协调机制(E10/E12 端口边界不破)。
- 承重结构化数据只进 frontmatter;正文非权威、永不进 projection。
- `rejected` 非空且每条带 `why_not` 是**硬校验**,空 rejected → invalid(否决比选择更重要)。**[Relation SoT 澄清] rejected/chosen/claims 不带 `evidence_refs`;其证据覆盖必须由 typed `relations:` record 中指向这些 anchor 的强 relation + 非空 `rationale` 表达,否则覆盖度 gate invalid。**
- `riskTier`(风险→评审深度)与 `urgency`(紧急→排队)是两个正交字段,不得合并。
- **decision 按 riskTier 分级裁决(E49)**:低 risk decision 确定性 check 自动过、不进人队列;只承重的进人裁。**不是每个 task 都产独立 decision**,只"产出承重"的 task 才 propose;一个 decision 可聚合多 task。决策队列长度 ≠ task 数,防重蹈批量确认地狱。
- fact 锚用稳定短 ID,**禁用行号**(行号随上方编辑漂移)。
- Relation 是独立一等 typed edge record,边走 `entity-relations/v1` schema。SQLite 只投影 typed relation records；不得从 decision/task/fact 正文或普通 refs 推导权威边。M3 v1 不做一条边一个 Markdown。
- 覆盖度判定靠 **relation 图可达**,不靠统计计数;统计仅辅助排序。
- provenance 导出是 **coordinator 内置自动步骤**,不是 skill 步骤(否则 task provenance 会漏)。
- v1 只两个 skill(`/decision`、`/decisions`),反 skill 膨胀;新触发器须由"无处触发"的真实需求逼出。
- 骨架由 vertical 物化;init 不再硬编码目录列表与脚手架文档模板(AGENTS.md/CLAUDE.md/repo-governance.md 内联字符串迁入 seededDocs,ADR-0016 D5 回写)。

### 3.2 健壮性不变量(5 项保留 + 3 项 E50 删除,保留项必须有自动化测试)

> 以下 5 项是防意外/防结构错误的机械级防御。每一项都必须有对应的自动化测试。

1. **INV-1 Human-CLI Fallback**:`CurrentSessionProbe` 在检测不到任何 Agent Runtime 时,**必须**静默降级为 `{runtime: "human", sessionId: "human-cli-<timestamp>", source: "manual"}`。Schema 层面 `provenance[].runtime` 允许 `"human"` 值。**绝不允许因探针失败而阻塞人类操作。** 验证:裸终端(无 Agent 环境变量)运行 `harness decision propose` → 成功落盘,provenance.runtime = "human"。

2. **INV-3 图遍历环安全(Cycle-safe Graph Traversal)**:环检测必须覆盖 task/decision/fact 三类实体节点,遇环截断并输出 Warning。**实现策略**:泛化现有 `post-merge-checks.ts:findRelationCycles` 的 DFS 算法,但边输入改为解析 typed `relations:` records 的 `source`/`target`;不再扫描 task 包正文里的 `target:` 正则,也不从 `evidence_refs` 这类内嵌字段造边。⚠️ **工作量注意(红队 B4):这不是"纯复用 DFS"**——DFS 内核(visiting/visited)可复用,但**输入抽取层是新写**:(a) frontmatter `relations:` 数组对象解析器(现 `readScalar` 是行级标量正则,做不到);(b) `entity-ref.ts` 的 `entityRefPattern` 现**硬编码 kind=`task`**、search 正则 `(?!/)` 在斜杠处截断,须扩到 `task|decision|fact` + 三段锚,且该正则被 `findEntityRefs/findDanglingEntityRefs/hasTaskRelations` **三处共享,一改全震**。按"抽取层重写 + 共享正则破坏性变更"排期。验证:构造含 decision/fact 节点的 A→B→C→A relation record 循环 → 环检测正常发现并报警,不挂起不 OOM。

3. **INV-4 Projection 读时免疫(Read-time Immunity —— watermark 存在性 + 全局唯一性)**:Projection 解析器在扫描 decision `.md` 重建 Graph 时,检查 Frontmatter 中的 `_coordinatorWatermark` 字段。缺少 watermark 的实体,或**与现有实体存在重复 watermark(防复制粘贴幽灵)** 的实体 → **静默丢弃,不进 Graph**(防幽灵决策污染);同时 `npm run check` **可见报错**(防静默丢弃的糟糕 UX)。watermark = coordinator 签发的 opId token(复用 kernel 共享写惯用法 `write-coordination/write-helpers.ts:51` 的 opId 生成机制——2026-07-02 T1 批次已从 `task-writes.ts` 抽出,含 `opIdPrefix` 泛化口——在 decision 落盘时注入 frontmatter,~25-35 行新增代码)。**不做 SHA-256 内容重算**(E50 SLIM-4:防作弊本地防不住,defer V2 配 CI-only secret)。验证:①手工写无 watermark 的 decision.md,或②复制粘贴另一个 decision.md 及其 watermark → rebuild 后不在 Graph 中 + check 报错。

4. **INV-5 Evidence Rationale 反 Goodhart**:relation record 的 `rationale` 是唯一结构化证据解释。`strength=strong` 或 `type=supports|blocks|supersedes|supersedes-fact|invalidated-by` 时 `rationale` 必填且非空,强制 Agent 解释“这条边为什么成立”。语法层强制有 rationale;语义层由 Arbiter 在 accept 时人工审查(V1 不做自动语义检查)。验证:强 relation fixture 缺 rationale 或空字符串 → schema invalid。

5. **INV-6 悬空指针扫描(Dangling Pointer Scan)**:`npm run check` 必须校验所有 relation `source`/`target` 可解析到 task/decision/fact 或其 anchor。**实现策略**:泛化现有 `post-merge-checks.ts:findDanglingEntityRefs` 的 known set,从 task packages、decision packages 和 task 内 fact anchors 构建 `knownEntityIds`;relation 文件引用不存在的 endpoint 或 anchor 即 hard-fail。⚠️ **必须枚举包内 F-id(红队 B2)**:现状 `findDanglingEntityRefs` 只构建 `knownTaskIds` 集合、只识别 `task/` 前缀,**不枚举 findings/progress 表行里的 F-id**——这个 fact 级 resolver 是新写的,不做的话"fact 悬空"这个安全网当前为假(人正常编辑 findings.md 删一行 fact → 指向它的边悬空而 check 不报)。**且注意 fact 保护不对称**:decision 有 `_coordinatorWatermark`、fact 是裸表行无任何写守卫——fact 表行删除应经 coordinator 落审计(而非自由改正文),否则悬空扫描是唯一防线、必须做实。验证:制造一个 relation 引用不存在的 `decision/<missing-decision-id>` 或 `fact/<task-id>/F-DEADBEEF`,以及**删除一条已被引用的 F-id 表行** → `npm run check` 均报错退出。

> **E50 删除的不变量(理由见 `03-slimming-pass` §7):**
> - ~~**INV-2 I/O Proxy 物理记录仪**~~(CUT-1:四个 runtime 自带磁盘日志覆盖,拓扑不兼容)
> - ~~**INV-7 Proposer-Arbiter Sybil 防御(强校验)**~~(SLIM-7:保留 actorClass 记录作审计靶子;删除“高 riskTier 拒 agent accept”强校验——actorClass 本地自填可伪装,强校验防不住真 Sybil,只防“agent 忘了标”)
> - ~~**INV-8 Fact 内容不可变性(Content Hash)**~~(CUT-4:内容篡改检测=防作弊,本地共享环境防不住)
>
> **安全边界声明**:保留的不变量防的是“意外”(人手误、忘标、合并冲突丢锚),不防“故意作弊”。真正的强制(CI-only secret、GPG 签名、远程 Arbiter)属 V2。此边界在 M3 scope 内显式承认,不假装不存在。


### 3.3 写时防御策略(E50 精简后)

- decision 写走**可见 watermark 存在性 + 唯一性检查**(CUT-3/SLIM-4 合并防复制幽灵):coordinator 写 decision 时在 frontmatter 注入 `_coordinatorWatermark`(复用 opId);`npm run check` 扫到缺 watermark 或重复 watermark 的 decision → 报错(可见);projection rebuild 跳过这些实体(保持图干净)。**[E50:原 E39"必须 hook 强拦"不可实现(R4 已承认),四层防御砍到一层——路径正则①/git precommit③/SHA-256 全砍,②④合并为可见 watermark 存在性+唯一性检查]**
- session 原文存储:`harness/sessions/<id>.md`(导出器渲染)**进 git**(体积可控,为 provenance 审计提供共享基准)。**不建 I/O Proxy 双层架构**(E50 CUT-1:四个 runtime 自带磁盘日志,复用即可)。


## 4. 明确不做(defer)

- **决策吸收/塌缩、风化/回流的自动代谢 daemon** → V2(做出来才能定义,不是想出来的)。
- urgency × riskTier 的具体档位 pipeline 数值 → M3 实现时定,不预设。
- daemon / MCP server / 自定义 GUI → 不在 M3;M3 是 CLI+skill,GUI 走 gui 线。
- 父子 / DAG / task-tree 产品化 → 仍归 PLT-TaskTree;M3 只提供 relation 底物(E42 与 E30 边界)。
- 为 fact / architecture / milestone 等建独立 skill → 反 skill 膨胀(E46)。
- 对话事实流成为持久化的"第四样元语" → 不做;只凝结被 promote 的段 + provenance 绑定原文。

## 5. 对抗审查揭示的工程现实风险(2026-06-25,三路独立审查交叉印证)

> 这些是 packet 一句话描述掩盖的真实工程量/不可实现项。执行 agent 必读,否则会低估 2.2-2.5 倍工作量或交付假象。

- **R1 provenance 跨层注入是真问题**:coordinator 的 actor 是死标签(`{kind,id}`,无 sessionId),kernel 层零运行时知识。要让 coordinator 落盘时写 provenance,需在 WriteOp 上挂 `provenance` 载荷 + CLI 层注入当前 session;而"CLI 怎么知道当前 session id"需每个 runtime 写一个探测器(4 runtime)。**建议:session 探测独立成 port(`CurrentSessionProbe`),kernel 只消费接口。** 影响 TP-08。(新增 TP-M3-07a 解决,**含 human-cli-local fallback(INV-1)**)
- **R2 provenance 导出仍有跨 runtime 工程量,但 I/O Proxy 已按 E50 删除**:M3 复用各 runtime 自带磁盘日志并只移植 JSONL/日志→markdown 渲染核心;不做 Harness 父进程录像、不做 `.raw.jsonl`、不做结构化分段/摘要。风险收敛为 session 探针覆盖与导出器健壮性,由 TP-07a/07b 分别处理。
- **R3 projection 是增量扩展,不是从零搭图数据库**:现有 `sqlite-projection-store.ts` 已有 `DatabaseSync`、表创建和 rebuild 机制;TP-06 在其上加 relation 边表、入边/可达/覆盖度查询。环安全复用并泛化现有 `post-merge-checks.ts:findRelationCycles`,不在 SQL 里另造 WITH RECURSIVE 环检测。
- **R4 decision 写"真强拦"不可实现 → E50 收敛为一层可见防意外检查**:Claude Code PreToolUse 拿不到"这次写的是不是 decision"的语义,路径正则/文件名 hook 可绕过且噪音高。M3 只做 check 可见报错 + projection 跳过:缺 `_coordinatorWatermark` 或重复 watermark 的 decision 不进图。
- **R5 真实工作量 ≈ 25-30 人日(⚠ 历史口径,已被红队 D3 重估取代,现行 canonical = ~40-50 人日,见 §2 末与 rollout §7)**。最大剩余成本:TP-03(EntityId 泛化 + 7 op × journal 测试)、TP-06(relation 边表 + 可达/覆盖度 + 现有检查泛化)、TP-07/08(session 探针 + 导出器 + provenance 注入)。
- **R6 原最高烂尾风险已删除**:TP-10 猫鼠游戏、I/O Proxy、SHA-256 内容校验、fact content-hash、高 risk actorClass 强拒均不再是 M3 交付。剩余风险是普通工程范围和 packet 边界控制。
- **R7 新增风险(本轮审查揭示)**:①悬空指针在纯文本协作环境中必然发生(人类误删 Fact ID、合并冲突丢失锚点),必须有编译级检查(INV-6);②relation rationale 的 Goodhart 逃逸(Agent 为过检随便连一个活跃 Fact),必须在 Schema 层强制 `rationale` 字段(INV-5),语义审查由 Arbiter 负责。

## 6. 对抗审查揭示的本体论待决项(需用户裁决,非工程)

- ~~**O1 fact 失效语义**~~:**已决(E49)**——fact 仍无状态机,失效靠 relation 边 `supersedes-fact`/`invalidated-by`(复用 entity-relations,不另造状态机)。风化查覆盖度顺这些边判定 fact 是否活着。
- ~~**O2 task.done ↔ decision 耦合**~~:**已决(E49)**——decision 按 riskTier 分级,低 risk 自动过不进人队列;**不每个 task 产 decision**,只承重的产,且一个 decision 可聚合多个 task。决策队列长度 ≠ task 数。
- ~~**O3 Goodhart rejected**~~:**已决(E49 + §3)**——rejected/chosen/claims 每个承重 anchor 必须经独立 relation record 沿图可达活 fact,且强 relation 带非空 rationale,否则 invalid。
