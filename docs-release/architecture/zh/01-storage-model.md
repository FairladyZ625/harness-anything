# 撰写记录如何落盘

[三原语内核](../../learn/zh/01-three-primitive-kernel.md) 主张 decision、task、fact 就是整个
内核,并且它们存储得不对称——decision 集中式、task 是容器、fact 嵌入式。这一页展示这套主张
落成真实文件时的样子:目录、每个文件必须携带的 frontmatter,以及模式所强制的 ID 形状。

每个实体在物理上都是同一样东西:一份顶部带着 YAML frontmatter 块的纯 Markdown 文件。这个
frontmatter 不是装饰——在文件被接受之前,它会对着 `packages/kernel/src/schemas/` 里的一个模式
做校验,所以下面这些字段是契约,不是惯例。

## 目录结构

```text
  <仓库根>/
  ├── decisions/                        集中式:主干
  │   ├── <某个 decision 文档>.md
  │   └── <另一个 decision 文档>.md
  │
  ├── objects/
  │   └── sha256/<2 hex>/<62 hex>        内容寻址 blob
  │
  └── <tasks 根>/
      └── task_<ULID>-<slug>/           每个 task 一个目录
          ├── INDEX.md                  frontmatter: task-package/v2
          ├── task_plan.md              叙述:计划
          ├── progress.md               叙述:进度
          ├── review.md                 叙述:判断
          ├── closeout.md               叙述:收尾
          ├── facts.md                  本地 fact 账本
          ├── executions/exe_<ULID>.md  一轮不可变交付
          └── reviews/rev_<ULID>.md     一轮不可变裁决

  <sessions 根>/
  └── <session-id>.md                   捕获的 Session manifest
```

三个原语,但只有两个存储位置。**Decision** 一起住在顶级 `decisions/` 目录里——它们是唯一一个
应该让人类盯着看的投影,所以被放在一处。**Task** 是容器:每个 task 是它自己的目录,命名为
`task_<ULID>-<slug>/`,里面放着一小组文件。**Fact** 完全没有属于自己的目录——它们被记录在
产生它们的那个 task 的 `facts.md` 账本里。fact 从不迁出;如果它在别处也重要,由某个 decision
就地引用它。

`objects/sha256/` 树不同于这些手写 Markdown 面。它是内容寻址 blob store。一个 blob 由它的
SHA-256 摘要寻址，存成 `objects/sha256/<前两个十六进制字符>/<剩余十六进制字符>`，描述符携带
`ref`、`sha256`、`size` 和 `mediaType`。session 导出把它当作 claim-check：先把 session 正文
写入 blob store，然后 journal payload 携带 `bodyRef`，flush 时再从这个已校验的 blob 物化出手写树
里的 session 文档。v0 没有 GC，也没有分块；大的或过期的 blob 会一直作为完整文件存在，直到后续存储
版本定义回收策略。

## 执行链

每次有效 claim 都会在 Task 下创建新的 authored Execution。Execution 持有 Session
bindings、`OutputEvidence` value objects，并在 submit 后持有六字段 packet：
`completion_claim`、`deliverables`、`evidence_refs`、`verification_notes`、
`known_gaps`、`residual_risks`。只有 completion claim 必须非空，其余数组均可为空，
所以纯文字交付与零条 Evidence 都合法（依据 `dec_mrg3z1we/CH1`、ADR-0027 D1、D3）。

`OutputEvidence` 不是另一种 Entity，也不是封闭的语义媒体枚举。它归 Execution
所有，并且恰好使用一种 locator substrate：inline、仓库相对 file、可解析 URL、
authored CAS object 或 registry entity ref。Review 是针对某个 submitted Execution 的
独立不可变文件；`review/v2` 记录 `evidence_checked`、findings、verdict 与非空 rationale
（依据 `dec_mrg3z1we/CH2-CH4`、ADR-0027 D5-D6）。

## decision 文件

一份 decision 文档携带的 frontmatter 对着 `decision-package/v1` 校验
(`packages/kernel/src/schemas/decision-package.ts`)。那些承重的字段:

| 字段 | 装的是什么 |
|---|---|
| `decision_id` | 稳定 ID,模式 `dec_...` |
| `title` | 这个选择,一句话 |
| `state` | `proposed → accepted → active → retired / rejected / deferred` |
| `riskTier` | `low` / `medium` / `high` |
| `urgency` | `low` / `medium` / `high` |
| `vertical`、`preset` | 它属于哪个领域和哪个 profile |
| `applies_to` | `{ modules[], productLines[] }` —— 它的作用范围 |
| `proposedBy` | 提出它的行动者 |
| `arbiter` | 裁决它的行动者 |
| `question` | 正在被决定的是什么 |
| `chosen[]` | 被采纳的选项(每个是带锚点的 `{ id, text }`) |
| `rejected[]` | 未采纳的选项,每个都带一个 `why_not` |
| `claims[]` | 这个选择所依托的、承重的主张 |
| `relations[]` | 指向其他实体的类型化边 |
| `provenance[]` | 至少一条,把它绑定到产生它的东西 |

其中两个值得细看。

**关于 `proposedBy` 与 `arbiter` 的完整性规则。** 模式不只是给这两个字段定类型;它对整条记录
做过滤。一个 `proposedBy` 等于 `arbiter`——同种类、同 id——的 decision 会被**拒绝**。你不能
裁决你自己的提议。这条规则在模式层强制,所以这种形状的畸形 decision 从一开始就到不了磁盘。

**`_coordinatorWatermark`。** decision 还携带一个可选的 `_coordinatorWatermark` 字段。你不用手写
它;单一写路径在记录穿过时把它盖上。它的存在,是这次写入走了那道唯一的门、而不是绕过它的印记
——其机理是 [02 · 单一写路径](02-write-path.md) 的主题。

## task 包

一个 task 是一个目录,`task_<ULID>-<slug>/`。ULID 让 id 可排序且唯一;slug 让目录可读。目录里,
`INDEX.md` 是实体记录,其 frontmatter 对着 `task-package/v2` 校验:

| 字段 | 装的是什么 |
|---|---|
| `task_id` | task 的稳定 id |
| `title` | 这个 task 是什么 |
| `lifecycle` | 生命周期绑定 —— 携带该 task 的 `status` |
| `vertical`、`preset` | 它属于哪个领域和哪个 profile |
| `provenance[]` | 至少一条,把它绑定到产生它的东西 |

task 的 `status` 活在它的 `lifecycle` 绑定里,而它是一台真实的状态机——一个 task 会在 planned
(规划中)、active(进行中)、blocked(阻塞)、in-review(评审中)、done(完成)、cancelled
(取消)这样的状态之间流转,而不是一张自由形式的便签。目录里其他文件是围绕这个状态的叙述:
`task_plan.md` 是计划,`progress.md` 是进度,`review.md` 是对其产出的判断,`closeout.md` 是收尾。
它们都不是 task 状态的真相来源——`INDEX.md` 的 frontmatter 才是。

## fact 账本

fact 记录在 task 的 `facts.md` 里,每条对着 `fact-record/v1` 校验
(`packages/kernel/src/schemas/fact-record.ts`):

| 字段 | 装的是什么 |
|---|---|
| `fact_id` | 模式 `F-` + 8 个 Crockford base32 字符 |
| `statement` | 观察本身 |
| `source` | 观察从哪里来 |
| `observedAt` | 何时观察到的 |
| `confidence` | `low` / `medium` / `high` |
| `memoryClass` | 该 fact 为召回而做的分类 |
| `memoryTags[]` | 用于检索的标签 |
| `provenance[]` | 至少一条,把它绑定到产生它的东西 |

`F-` 的 id 模式是 `F-` 后面紧跟恰好八个 Crockford base32 字符(数字与大写字母,排除掉容易混淆的
`I`、`L`、`O`、`U`)——短、无歧义、可安全复制。

**Fact 是仅追加的(append-only)。** 一个 fact 恰好有两个创建动作:*record*(记录)与
*invalidate*(失效)。没有编辑。一旦写下,fact 就冻结了——如果现实变了,你记录一个新的 fact,
如果旧的现在错了,就让它失效;你永远不去重写原来那条。这正是 fact 能被当作证据信任的原因:
你读到的陈述就是当初被记录下来的陈述,原封未动,旁边还有说明它在什么条件下被观察到的出处。

append-only 并不意味着每一次重复追加都会报错。当 fact append 重放一条已有 `fact_id` 的记录时，
存储层会比较格式化后的记录字节。如果现有记录与传入记录逐字节相同，这次追加就是幂等 no-op，文件
正文保持不变。如果 id 相同但字节不同，写入仍会作为重复 fact id 被拒绝。

## 共同的那根线:出处

三个实体中的每一个都携带一个 `provenance[]` 数组,至少一条。一条出处记录把它绑定到产生它的
运行时与会话——正是它让任何一份文件,哪怕几个月后冷读,依然能回答"这是谁、或什么创建的,何时
创建的"。decision、task、fact 在几乎所有其他方面都不同;在这一点上它们完全一致。出处的完整
故事、以及它如何被回填,在 [06 · 出处、裁决与事件账本](06-provenance-and-events.md)。

下一个问题是:当这些文件之一被写下时,会发生什么——一条记录到底如何安全、可归因地抵达磁盘。
那就是 [02 · 单一写路径](02-write-path.md)。
