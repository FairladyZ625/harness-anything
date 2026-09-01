# Legacy 台账恢复：当仓库拒绝一切命令时

状态：面向「已注册、但台账里仍留着当前代际读取时拒收的 legacy migration 事件」的仓库的恢复
路径。本页做的是原地修复。若要把上一代际的仓库迁进一个全新初始化的仓库，请改读
[migration-genesis-replay.zh-CN.md](migration-genesis-replay.zh-CN.md)。

## 症状

你升级之后，这个仓库对所有命令给出同一个回答：

```console
$ ha task list
error code=repo_unavailable hint=this workspace stays latched until its ledger data verifies: repair the data-shape cause below, then rerun the command; the next attempt re-probes the ledger and re-attaches automatically once the data verifies. Cause: migration task entity is invalid
```

这一行里同时有三件事成立：

- daemon 没有弄丢你的数据，也不是误把你锁在门外。它拒绝 attach 这个仓库，是因为台账
  过不了当前 canonical-event 契约的校验。
- 成因是数据形状缺陷，不是基础设施故障。上面的例子点名
  `migration task entity is invalid`；处于同样局面的另一个仓库可能点名别的字段。无论
  点名哪个，恢复路径都相同。
- 这个闩是按自愈设计的。数据一旦通过校验，下一条命令会重新探测台账并自动 re-attach。
  这一步不需要你手工重启任何东西。

动手前先读 `Cause:` 文本。本页覆盖的是 data-shape 这一类——成因指向你台账内部的某个
事件或实体。如果 hint 说的是工作区要等 *Git 或锁基础设施* 恢复、或等 *projection*
校验通过，那不是本页的问题：按那条 hint 自己的指示走（projection 类用
`ha daemon projection rebuild`，infrastructure 类按点名的基础设施修复处理）。

## 到底哪里坏了

当前 daemon 经由严格的 canonical-event 解析器读台账。由更早代际迁移过来的仓库，里面可能
还留着不满足今天契约的 migration 事件——例如一个 `migration-import-event/v1`，其 task
实体缺少如今必填的 `provenance` 字段。解析器拒收整个台账，该仓库的 cell 保持未 attach
（「上闩」），于是每一条需要这个仓库的命令都返回 `repo_unavailable`。

修复不是手工改数据。以下三件已经存在于 daemon 中，合起来让一条恢复命令就足够：

- **恢复准入。** `ha migrate import` 与 `ha migrate rekey-facts` 经由该仓库的单写者恢复
  通道进入一个上闩的仓库。数据未通过校验期间，普通命令维持拒收。
- **oracle 重建。** migration oracle 不再信任过期的派生缓存。缓存投影与 canonical 事件头
  不一致时，它重放检视过的、已规范化的 canonical 流来重建一个一次性视图，并且只有在该
  视图恰好等于事件头时才接受。你不需要手工处理 `.harness/cache/task.sqlite`。
- **provenance 重述。** `ha migrate rekey-facts` 会为「`payload.entity.provenance` 键缺失」
  这一精确的 legacy 形态规划一次原地重述：补上 `provenance: "imported_snapshot"`，并同
  步规范化内嵌的 legacy task 体。其余无效形态保持原有的 typed 拒绝。

这里没有任何一处放松校验。重述后的字节仍须通过与任何其他写入相同的严格 canonical-event
序列化；恢复只是补上今天契约要求、而昨天的写入者漏掉的那个字段。

## 恢复准入的行为

每个仓库同一时刻只有一条恢复，走同一条队列：

- 第一条恢复命令先认领该仓库的恢复准入，再加入既有的单写队列。第一条尚未 settle 时
  到达的第二条恢复命令会以 `recovery_conflict` 拒收，并点名该等待的命令。
- dry-run 不发布任何东西，也不清闩。只有 apply 会。
- 恢复是唯一的入口。边缘节点或直接写文件都打不开一个 unavailable 的台账；不存在第二套
  准入机制可供寻找或发明。

## 开始之前

1. **每条命令都在该仓库的注册根目录下执行**，让 daemon 解析到正确的仓库。多仓库路由见
   [operations-server-daemon.zh-CN.md](operations-server-daemon.zh-CN.md)。
2. **冻结该仓库的其他写入者**——其他 agent、GUI 会话、定时任务。恢复命令走 daemon 的
   单写队列，因此不需要停 daemon；需要的是没有别的东西在写这份台账。
3. **提交切面。** 台账必须是完全 committed 的快照。恢复与导入器都会拒收未提交的源，这个
   拒收是对的：未提交的切面既无法校验也无法重放。
4. **备份台账。** 给台账自己的嵌套 git 仓库打 tag，不是外层项目仓库：

   ```bash
   git -C <项目根>/harness tag backup/pre-migrate-<名称>-<yyyymmdd>
   git -C <项目根>/harness rev-parse backup/pre-migrate-<名称>-<yyyymmdd>
   ```

   tag 必须解析到台账仓库自己的 `HEAD`。用外层项目仓库的 commit 去打 tag 会被 git 拒绝，
   因为那些对象在嵌套台账仓库里不存在。

## 恢复的逐步流程

| 步骤 | 执行 | 预期形态 | 下一步 |
| --- | --- | --- | --- |
| 1. 确认症状 | `ha task list` | `error code=repo_unavailable … Cause: <data-shape 成因>`，退出码 1 | 成因是数据形状缺陷则继续。 |
| 2. 冻结写入者、提交切面 | `git -C <项目根>/harness status --porcelain` | 为空 | 先把台账的遗留编辑提交掉。 |
| 3. 备份 | `git -C <项目根>/harness tag …` | tag 解析到台账 `HEAD` | 保留 tag；成功之后也不要删。 |
| 4. 预演 | `ha migrate rekey-facts --dry-run` | counts 行、每个被重述事件一行、marker 行 | 对账（见下）。 |
| 5. 执行 | `ha migrate rekey-facts` | 相同的 counts 与行，marker 行不带预演 op | — |
| 6. 验证幂等 | `ha migrate rekey-facts --dry-run` | 所有计数为 `0`，没有任何行 | 完成；不存在半应用状态。 |
| 7. 确认 re-attach | `ha task list` | 出任务行，无报错 | 仓库恢复可用。 |

### 4. 预演恢复计划

```bash
ha migrate rekey-facts --dry-run
```

```text
maps:
counts: rekeyedFacts=0  factEvents=0  producesEdges=0  retargetedRelations=0  rewrittenRelationEvents=0  rewrittenEmbeddedRelationEvents=0  rewrittenMigrationTaskEvents=<N>  rewrittenDecisionEvents=0  rewrittenTaskEvents=0  rewrittenAgentEvents=0  rewrittenSettingsEvents=0
migrationTaskProvenanceRestatements:
migration-<op-id>	events/<shard>/migration-<op-id>.json
… 每个被重述事件一行 …
schema=fact-rekey-id-map/v1  markerOpId=op_<sha256>
```

加 `--json` 可得到同一份回执的单对象机器可读形态。

### 5. 对账，然后执行

执行前先对账。两项检查，都是机械的：

- `rewrittenMigrationTaskEvents` 是本次恢复将重述的 legacy migration task 事件数。它必须
  等于 `migrationTaskProvenanceRestatements` 的行数，而且你应该能用自己的历史把它对上——
  当年那次旧迁移到底导入了多少个 task？
- 其余所有计数都是 `0`。若另一个重述面出现非零计数，说明恢复计划里有本页没有描述的
  工作量。停下来先读那份报告，再决定是否执行。

然后执行：

```bash
ha migrate rekey-facts
```

执行输出打印同样的 counts 与同样的行，结尾的 marker 行是
`schema=fact-rekey-id-map/v1`，不带预演的 `markerOpId`。被重述的事件保持身份——
`eventId`、`opId`、revision 都不变——只改缺失的 provenance 键，外加在内嵌 legacy task 体
存在时对它做规范化。命令随后从修复后的台账重建投影。

如果台账仍在使用 legacy `flat/v1` 对象布局，执行回执的结尾会多一行提示
`ha migrate ledger` 的 advisory。那是对布局的观察，不是错误，也不影响本次恢复。

### 6. 验证幂等

```bash
ha migrate rekey-facts --dry-run
```

```text
maps:
counts: rekeyedFacts=0  factEvents=0  producesEdges=0  retargetedRelations=0  rewrittenRelationEvents=0  rewrittenEmbeddedRelationEvents=0  rewrittenMigrationTaskEvents=0  rewrittenDecisionEvents=0  rewrittenTaskEvents=0  rewrittenAgentEvents=0  rewrittenSettingsEvents=0
schema=fact-rekey-id-map/v1
```

所有计数为 `0`，没有重述行，也没有预演 marker。再执行一次 apply 得到同样结果也是安全的：
重复 apply 是 no-op。

### 7. 确认仓库已 re-attach

```bash
ha task list
```

任务行回来了，不再报错。你没有运行过任何 re-attach 命令，它也不存在：数据通过校验后，
闩会在下一条命令上自动重探。

### 如果你还需合并外部快照

上面的恢复修复的是你所在的这个仓库，它不合并任何东西进来。若你还有第二个外部的 Harness
仓库要并入本仓，那是创世重放的 import 路径，而且它现在也走同一条恢复准入：

```bash
ha migrate import --source <另一仓库路径>/harness --dry-run
ha migrate import --source <另一仓库路径>/harness
```

dry-run 不写任何东西，并以同 cut 或一次性重建的 oracle 对五类现役实体——task / decision /
fact / relation / execution——做对账。完整流程、`--resolve` 冲突语法与验收等式见
[migration-genesis-replay.zh-CN.md](migration-genesis-replay.zh-CN.md)。每次都先跑 import
dry-run。

## 出错怎么办

| 报告 | 含义 | 动作 |
| --- | --- | --- |
| `recovery_conflict` | 另一条恢复命令已持有该仓库的单写者恢复准入。 | 等 hint 点名的那条命令 settle，再重跑。不要另开第二条路。 |
| `publication_indeterminate`（带 `git … update-ref …` 提示） | daemon 之外有人 commit 过，台账分支不再指向最后一个已发布事件 commit。 | 原样执行报错里打印的那条 `git -C … update-ref …`——它只移动分支指针，不动任何文件——然后 `ha daemon stop`，再重试恢复。 |
| 源因未完全提交被拒收 | 台账工作树有未提交改动。 | 提交（或移开）后重跑 dry-run。不要迁移脏切面。 |
| `migration_projection_oracle_cut_mismatch` | 过期的派生投影与 canonical 事件头不一致。 | oracle 会自行回落到一次性重建。若报错持续，停掉源的写入者并读内层原因。不要手工删除或移动 `.harness/cache/task.sqlite`——过期缓存会被就地重建，把它移开只会得到同样的判定。 |
| 缺 provenance 形态之外的 typed 拒绝 | 台账里有本恢复不重述的无效事件。 | 保留台账，收集点名的事件与 schema，然后报告。为未描述的形状猜一个重述不是恢复。 |
| 尚未 apply 时 dry-run 全部计数为 `0`，且 `ha task list` 仍然失败 | daemon 早于 provenance 重述分支，那个版本会跳过无效事件，而不是为它们的修复出计划。 | 把 daemon 升级到带重述分支的构建，再重跑 dry-run。计数非零，闩才有可能被清掉。 |
| 幂等 dry-run 干净之后仍持续 `repo_unavailable` | 闩的成因不属于本恢复所 settle 的 data-shape 类。 | 重读 `Cause:` 文本并按该类的 hint 处理；另见 [operations-server-daemon.zh-CN.md](operations-server-daemon.zh-CN.md)。 |

有两个错误值得点名，因为它们看起来都很有产出，其实都不是：

- 手工删除或改名派生缓存没有用。过期缓存会被从已提交事件就地重建；把它移开，你会得到
  一个重建出来的缓存和同一个判定。
- 手工编辑 legacy 事件 JSON 去补那个缺失字段，不是同一个操作。恢复在单写队列内重述事件、
  保持身份、并对结果重新校验。在该队列之外的手工编辑，恰恰就是制造
  `publication_indeterminate` 的那种 daemon 之外的 commit。

## FAQ

**恢复过程中我的数据有风险吗？**
恢复在 daemon 的单写队列内重写事件文件，把每个被重述的字节重新过一遍严格 canonical-event
契约校验，并从结果重建投影。你在开始前打了 tag，所以无论如何，恢复前的状态都可回退。

**为什么 dry-run 不修任何东西？**
dry-run 不发布任何东西，也不清闩。它存在的意义是让你在任何字节改变之前对账这份计划——
哪些事件、多少条、以及没有别的。

**我需要停 daemon 吗？**
不需要。恢复命令走 daemon 的单写队列；正是这条队列让重写变得安全。要停的是这个仓库的
*其他* 写入者。`ha daemon stop` 只出现在上面 `publication_indeterminate` 的恢复里，而且
那是跟在 ref 修复之后的动作。

**其他面上的计数不是零，怎么办？**
停下来，先读报告再决定。本页描述的恢复，其唯一计划的工作量就是 provenance 重述；另一个
计数非零意味着那是另一份计划，需要单独弄清楚，而不是放宽批准范围。

**重述后的事件会看起来像被迁移过吗？**
它们本来就像。重述补上的 `provenance` 标记说的是这个 task 是作为导入快照进来的；它不改
变发生了什么、何时发生、以及是谁做的。

**本页没写到的命令或 flag？**
本页只覆盖上述恢复面。运行 `ha migrate --help` 查看权威的命令描述。
