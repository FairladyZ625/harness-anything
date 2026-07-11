# 投影:从 Markdown 到 SQLite

[概览](../../learn/zh/00-overview.md)立足于同一个形状,[01 · 三原语内核](../../learn/zh/01-three-primitive-kernel.md)也建立在同一个前提上:git 仓库里的 Markdown 是真相之源,而 SQLite 是一个**可重建的投影(projection)**——一个快速读缓存,你随时可以删掉它、再从 Markdown 重新生成。本页展示这个投影是怎么被构建的、里面装了什么、如何检测陈旧,以及为什么删掉它永远是安全的。

## 源是 Markdown,SQLite 是派生物

数据库里没有任何权威内容。每一行都是 Markdown 文件的机械函数：Task 与 Decision 记录、
类型化关系、Session manifest、Execution、Review。数据库只为索引读取存在；如果它与 Markdown
不一致，按定义数据库就是错的，修法永远是扔掉再重建（ADR-0027 D1、D5）。

## 重建流程

重建是单趟(single pass)完成的,由 `packages/kernel/src/projection/sqlite-task-projection.ts` 里的 `rebuildTaskProjection` 实现:

```text
扫描 Markdown            readMarkdownSource:task INDEX.md 文件
                         readDecisionProjectionRows:decision 文档
   |
校验 + 转换              每条 entry -> 一行类型化的 row(已排序)
                         (frontmatter 必须匹配其 schema)
   |
哈希                     对 Markdown 求 sourceHash,
                         对 rows 求 rowsHash + decisionRowsHash
   |
构建关系图               buildRelationGraphProjection:
                         edges、coverage、fact anchors
   |
写出全新 SQLite          writeProjectionDatabase 先写进临时文件,
                         再 renameSync 到位(原子)
```

每一次重建都产出一个*完整、全新*的数据库——不存在会逐渐漂移失同步的、就地增量修改。表是从零创建的,所有 row 插入,索引建好,最后把完工的文件原子地换上去。写入采用和[写入路径](02-write-path.md)相同的"先临时、后改名"纪律:`writeProjectionDatabase` 把数据库构建进一个 `.<pid>.<时间戳>.tmp` 文件,再用 `renameSync` 盖到真实路径上,于是读取者永远看不到一个建了一半的数据库。

## 数据库里装了什么

投影包含 `packages/kernel/src/projection/sqlite-projection-store.ts` 创建的六张基础表，以及由
声明派生的 Session、Execution、Review 表：

| 表 | 主键 | 装的东西 |
|---|---|---|
| `projection_meta` | `key` | 键值元数据:`version`、`sourceHash`、`rowsHash`、`decisionRowsHash`——新鲜度指纹 |
| `task_projection` | `task_id` | 每个 task 一行:`title`、`canonical_status`、`coordination_status`、`raw_status`、`package_disposition`、`closeout_readiness`、`lifecycle_engine`、`freshness`、`updated_at`、`source`、`source_path`、`vertical`、`preset`、`profile`、`module_key`… |
| `decision_projection` | `decision_id` | 每个 decision 一行:`state`、`title`、`question`、`chosen_json`、`rejected_json`、`module_keys_json`、`product_line_keys_json`、`decided_at`… |
| `relation_edges` | `relation_id` | 每条类型化关系一行:`source_ref`、`target_ref`、`relation_type`、`direction`、`state`,以及完整的 `row_json` |
| `relation_coverage` | `claim_ref` | 哪些 decision claim 被覆盖:`decision_ref`、`status`(`covered`/`uncovered`)、`covering_fact_ref` |
| `task_fact_anchors` | `fact_ref` | 每个 fact 落在哪里:`task_id`、`fact_id`、`source_path` |
| `session_projection` | `session_id` | Session lifecycle、runtime、archive status 与 snapshot 元数据 |
| `execution_projection` | `execution_id` | Task/executor、状态、带 capture range 的 Session bindings、Submission Packet 与 OutputEvidence |
| `review_projection` | `review_id` | 被审 Execution、reviewer、`evidence_checked`、rationale、findings 与 verdict |

之上还有若干索引，让常见查询保持快速。关键边界是：Execution binding 暴露稳定
`range_id` 与含首尾的 timestamp interval（封存前 `end_at` 为 null）；legacy binding
暴露 `capture_range: null`，而不是通过搜索 transcript 编造归属。Submission 与 Review
字段会直接进入投影，但投影绝不把机械 Evidence 结果变成语义 verdict（ADR-0027 D1、D5-D6）。

## 新鲜与陈旧

因为投影是派生的,它会落后于它的源——合并之后、编辑之后、拉了别人的提交之后。检测这一点,正是 `projection_meta` 里那些哈希的职责。

每一次读取,`readTaskProjection` 都会重读 Markdown、重算它的哈希,并和存下来的 `sourceHash` 比对。它也会用数据库当前的 row 重算 `rowsHash` 和 `decisionRowsHash`,再和记录的值比对。几种结果:

- **`sourceHash` 匹配**——投影反映的是当前的 Markdown;直接从它读取。
- **`sourceHash` 不同**——Markdown 在数据库构建之后变过了。投影*陈旧*;它会被透明地重建,并向调用方发出警告。
- **存下的 `rowsHash`/`decisionRowsHash` 已不再匹配库里的 row**——数据库被带外(out of band)编辑过了。这被当作*篡改*,是一次硬失败(hard fail),数据库被丢弃并从 Markdown 重建。
- **数据库缺失或读不出来**——直接重建。

同一套 `sourceHash`/`rowsHash` 比对,也驱动着 `packages/kernel/src/projection/post-merge-checks.ts` 里的合并后检查:它在合并之后标记出陈旧的投影,并且干脆拒绝让生成物(`.harness` 工作文件、`.projection.sqlite` 缓存)被提交进 git(`findTrackedGeneratedFiles`)。投影是一个本地缓存;它不属于仓库,检查会强制这一点。

## 关系图

六张表里的两张——`relation_edges` 和 `relation_coverage`,再加上 `task_fact_anchors`——装着把实体系在一起的那张图。重建时,`buildRelationGraphProjection`(`packages/kernel/src/projection/relation-graph-projection.ts`)读取嵌在 Markdown 里的类型化关系记录,把每个端点对照已知的 task、decision、fact 集合解析出来,并物化成:

- **edges**——每条类型化关系作为一行,以确定性的 `relation_id` 为键,带 `source_ref`、`target_ref`、`relation_type`、`direction`;
- **coverage**——对每个 decision claim,是否有 fact 覆盖它(`covered`/`uncovered`),以及是哪个 fact 覆盖的;
- **fact anchors**——每条 fact 记录实际落在哪个 task、哪个文件里。

那些指向不存在实体、构成环、或过不了记录级规则的关系,都会在这里被抓出来并作为硬失败暴露——这张图永远只会用真实存在的端点来构建。

## 数据库是可丢弃的

这就是上面一切所要保证的性质:**你可以删掉这个 SQLite 文件而什么都不丢。** 下一次读取发现它缺失,就从 Markdown 重建它;下一次合并检查发现它陈旧,就重建它;一次对数据库的带外编辑会被检测到并覆盖掉。git 里那份被授权的 Markdown 是唯一的真相之源,而投影是它的一个纯粹、可复现的函数——这恰恰就是"删掉再重建"之所以是一个安全操作、而非一次数据丢失事故的原因。
