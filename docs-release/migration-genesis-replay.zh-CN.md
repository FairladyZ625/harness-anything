# 台账迁移：创世重放

状态：台账格式早于当前代际的仓库必须走创世重放；已经 canonical、仅遗留
task-local fact 的仓库走单独的原地 fact rekey。

## 变更了什么

台账格式发生了代差变更。上一代写入的记录不满足当前 schema，因此老仓库
不能整体原地转换。已经 canonical 的仓库可能还留有迁移过渡期的
task-local fact 形态，这部分由下方唯一的 fact rekey 命令处理。

对老仓而言，唯一受支持的路径是**创世重放**：把老仓归档成只读底稿，
新建一个空仓，再把老语料作为 canonical migration 事件按原始顺序重放进新仓。

创世重放入口是：

```
ha migrate import --source <source> [--resolve <仓库相对路径>=destination|source]... [--dry-run]
    Import a legacy Harness repository; resolve reported destination conflicts with repeated --resolve path=destination|source.
```

两类输入各有且只有一条命令：

| 输入                                | 命令                                  | 前置                                                                     | 验收                                                                                                                   |
| ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 早于当前代际的老仓                  | `ha migrate import --source <source>` | 冻结写入、停止源 daemon，源必须是 committed snapshot，且现役 projection 与 canonical event head 在同一 cut；先跑 `--dry-run`。 | 五类现役 ID 集合满足 source ⊆ target；每类差异恰等于 derived + archived/retired；12-kind conformance 与 coverage 保全均通过。 |
| 已 canonical 但有 `fact/<task>/F-*` | `ha migrate rekey-facts`              | 停止该仓 daemon/写入者，在 committed canonical cut 上先跑 `--dry-run`。  | id-map 中 fact 与 `produces` 数量一致；SQLite fact/relation 计数稳定；`ha fact search` 与 `ha fact show <F-id>` 成功。 |

fact-only 路径只在 fleet center 执行一次。marker 携带 ledger epoch；边缘节点
和 replica 在重放前必须将该 epoch 与本地 projection 比较，发现更高 epoch
就丢弃 projection，按 canonical cut 做完整 cold rebuild。它们不再次 rekey，
也不自行生成替代 ref。

本页之外的内容，运行 `ha migrate --help` 查看权威描述。

## 为什么不能原地升级

原地升级要么把每一种历史记录形态永远背下去，要么静默改写历史。对一个价值就在于"可信记录"的台账来说，两者都不可接受。创世重放的做法是把老仓当作法证材料——冻结、只读、永久保留——再从已经满足当前 schema 的事件出发构建新线。

它的失败性质也值得直说：迁移的每一步里，老仓只被读取。任何一步出错，老仓都原样无损，恢复动作就是丢掉新仓重来。迁移过程中不存在会损害源数据的时刻。

## 五步流程

顺序承重。在 dry-run 对全部五类实体报出集合包含、差异解释等式成立，且
12-kind conformance 与 coverage 保全通过之前，不要跑正式导入。`skipped` 与
authored 目录数量不参与实体集合的通过计算；目标 preimage 冲突仍是独立的写入
安全条件，必须显式 resolve。

### 1. 备份老仓

这一步不可跳过。做两份独立备份：

- 一份全史 `git bundle`；
- 一份完整目录 clone。

建议至少一份存到本机之外。老仓在整个迁移过程中保持只读，不会被修改。

### 2. 新建空仓

```bash
ha init --repo-id <id> --person-id <id> --display-name <name>
```

这会生成 `harness/harness.yaml`、`harness/people.yaml` 以及 context/governance/adr/milestones 骨架，并自动把该仓注册进 daemon。

### 3. 先跑 dry-run

```bash
ha migrate import --source <老仓路径> --dry-run
```

dry-run 不写任何东西。它从源仓 `.harness/cache/task.sqlite` 读取与
`harness/events/head.json` 同 revision 的现役 projection，输出五类实体——
task / decision / fact / relation / execution——的 ID 集合对账。每类给出
source active、target included、difference、derived、archived、retired；通过条件是
source ⊆ target 且 difference = derived + archived/retired。decision 的承重 claim
coverage 另行保全。`Format observations`、`Attribution` 和 authored audit 是诊断信息。

当前代际的生产读写只接受 `Task/v2`，其中 `pinned` 必填。创世重放会在同一
次导入中读取老台账里的 `Task/v1` 事件，并把每个迁入 task 重述为 canonical
`Task/v2` migration 事件：源事件有 `pinned` 时保留原布尔值，没有时显式写
`false`；迁移实体同时写入 `provenance: imported_snapshot`。dry-run 的
`Task/v1 -> Task/v2` 行分别列出源 v1 数、目标 v2 数、保留 pinned 数、显式
false 数和 imported_snapshot 数。这些计数也进入结构化回执；缺失其他必填
字段不会从迁移当天猜测：缺 `title` 时依次取同一 task package 的
`task_plan.md` H1、`INDEX.md` H1；缺 `occurredAt` 时取该 task 最早 canonical
event 的时间。回执逐字段记录 `derived_from`，task provenance 固定为
`imported_snapshot`。仍不能满足严格合同的 task 保留原 ID 与原字段，重述成
`disposition=archived, reason=truth_gap`。

### 4. 阅读差异、处置目标冲突

目标冲突在用户逐路径明确选择前一直是 `required`。冲突行会同时给出源与
目标的节点类型、SHA-256、字节数；符号链接还会给出 link target。每条冲突
重复传一个 `--resolve`：

```bash
ha migrate import --source <老仓副本路径> \
  --resolve <仓库相对路径>=destination \
  --resolve <另一仓库相对路径>=source \
  --dry-run
```

`destination` 保留初始化出的目标节点，并显式丢弃源版本；`source` 只对该
文件或符号链接做 compare-and-replace。分类之后目标发生变化，导入会拒绝并
要求重跑 dry-run。目标是目录时只支持 `destination`，不支持 `source`；请
手工处置该路径后重跑。缺失、规范化后重复、非冲突或已经不再冲突的路径都
会被拒绝。

老线 `presets/**` 留在只读法证源仓，不会激活进目标仓。如需继续使用，按当前
`preset-manifest/v3` 重做每个
包，经 preset 命令验证并安装。不要把 v2 包搬进新仓；原始字节保留在归档
中，只从送给导入器的工作副本移出。

旧解析器产生的 `skipped` 不再从现役 projection 总数里相减，也不单独造成
退出码 3。导入器先按同 cut 见证派生；decision、execution 或 parent 仍不能
满足严格合同的实体，以 `disposition=archived, reason=truth_gap` 保留原 ID 与
原字段。端点或 owner 仍不可解析的 relation 保留原 relation ID，重述为
`state=edge_retired, reason=truth_gap`。每一条派生和 disposition 都进入结构化
回执，报告每类最多展示 20 条样本；没有任何见证但数量非零时也走这条规则，
不会静默丢失或停下来等待额外裁决。

### 5. 正式导入

```bash
ha migrate import --source <老仓路径>
```

验收条件：五类现役 ID 集合 source ⊆ target；每类 difference 恰等于
derived + archived/retired；coverage 保全；12-kind conformance 通过。任一项不满足
命令退出 1；全部满足退出 0。`skipped` 和 authored audit 不再改变预期总数，
也不再产生退出码 3。

## 迁移后的数据是什么性质

这一点最容易被误解，值得写明白。

**重放进新仓的实体是新线的原生实体。** 它们可以像新仓里的任何其他记录一样被创建、修改、流转、建关系。迁移不会在新台账里产生一个只读的"历史数据"区。

**只读的是老仓本身**，角色是归档的法证底稿。它永久保留，不再参与日常读写。

每个被迁移的实体带三个出处标记：

- 事件 `source` 为 `migration-import/v1`；
- `migratedFrom` 指向原仓；
- `generation: v0` 标记它来自上一代。

这些标记在后续写入后依然保留。只要记录存在，它们就一直能回答"这条记录是迁来的，还是新线原生产生的"。

事件按原始 `occurredAt` 时间戳顺序重放。历史时序不会被压平成迁移当天，新仓里的时间线就是工作实际发生的时间线。

## 出错怎么办

失败模型很简单，因为老仓全程只读：

- 任何一步出错，老仓都保持原样，零损失。
- 回退动作是丢掉新仓、重做迁移，不需要撤销别的东西。

这是创世重放相对原地升级的主要优势：不存在能把源数据改坏的半迁移状态。

## 仅 fact 原地 rekey

已 canonical 的仓库不要使用 genesis import。停止 daemon 和所有写入者，确认
canonical cut 已提交后，先预演再执行：

```bash
ha migrate rekey-facts --dry-run --json
ha migrate rekey-facts --json
sqlite3 .harness/cache/projections.sqlite \
  'select count(*) from fact; select count(*) from relation;'
ha fact search
ha fact show <F-id>
```

dry-run 回执中的 id-map 和计数是预期值。正式执行会把旧 ref 改成
`fact/F-*`，写入 `harness/facts/F-*.md`，重写 relation endpoint，为可确定的
owner task 写 `produces` 边，并删除 task-local `facts.md`。重复执行必须返回
no-op。无法确定 owner 的 fact 不伪造归属，会无 task 边 rekey 并列清单供后续
回填。

## FAQ

**老仓会被删除或改写吗？**
不会。它作为只读的法证底稿归档并永久保留。迁移只从它读取。

**迁移之后还能继续用老仓吗？**
老仓是参考副本。日常工作转移到新仓；老仓不再参与读写。

**可以跳过 dry-run 吗？**
不行。dry-run 固定 source projection 与 canonical event head 的同一 cut，并证明
集合包含和逐类差异解释。先审阅所有 derived/archived/retired 样本，再决定是否
正式导入。

**迁入的记录是二等公民吗？**
不是。它们是新线的原生实体，完全可写。唯一区别是出处：它们带 `migration-import/v1`、`migratedFrom` 和 `generation: v0` 标记，这些标记在后续写入后依然保留。

**历史会显示成迁移那天吗？**
不会。事件按原始 `occurredAt` 时间戳重放，新仓的时间线反映的是工作实际发生的时间。

**本页没写到的命令或 flag？**
本页只覆盖上述迁移面。运行 `ha migrate --help` 查看权威的命令描述。
