# 决策 vs 裁决

这是两个听起来像同义词、实际所指却完全不同的词——把它们混为一谈,是这套系统里代价最高的一个错误。两者都给人一种"权威裁定"的感觉,所以很容易被诱惑着用同一套机制去处理它们。一旦这样做,其中一个就会悄悄吞掉另一个。

## 两个不同的问题

**decision(决策)**回答的是*我们走哪条路?*——一个 WHY。**verdict(裁决)**回答的是*这个具体的输出成立吗?*——PASS 还是 FAIL。

| | Decision | Verdict |
|---|---|---|
| 回答的问题 | 我们走哪条路?(WHY) | 这个输出成立吗?(PASS / FAIL) |
| 性质 | 一次承重的选择 | 对某个具体输出的一次性判断 |
| 关系 | **原因**(一个持续生效的选择) | **结果**(对某次产出的检查) |
| 可推翻? | 可以——后来的 decision 能够**推翻(supersede)**它 | 不可以——它是单次裁定,默认 fail-closed |
| 落在哪里 | `decisions/` 里的一个 decision 实体 | 某个 task gate、某次 milestone exit、某场对抗性评审 |

decision 是原因:一个持续生效的承诺,塑造未来的工作。verdict 是结果:在某一时刻,对某个具体输出做的一次检查。decision 可以靠提出一个新的来推翻旧的;verdict 是一次性裁定,要么通过,要么(默认)不通过。

为什么把两者分开这么重要?因为如果每一次日常的 PASS/FAIL 都被塞进 decision 这套机制里,decision 队列——本该是唯一值得人类盯着看的东西——就会被大量逐条记账式的检查结果淹没,淹没到没人还能看清全貌,人们开始为了清空这堆积压而敷衍了事地放行。日常的 verdict 就是那场洪水;把它们挡在 decision 队列之外,才能让这个队列继续有意义。只有当一个 verdict 暴露出某种战略性的问题时(比如"这批结果说明我们可能选错了路"),它才会**触发**一个新的 decision。真正消费掉 decision 证据的时刻,是这次触发,而不是每一次例行检查。

## 决策命令族

要按工作流去理解,而不是按 API 去理解。一个 decision 沿着一小组封闭的操作流转:

```text
                 ┌──▶ reject
propose ──▶ accept / reject / defer
   │             └──▶ defer
   │
   └──▶ (once active) supersede · amend · retire
```

- **propose** —— 起草这个选择。提议时**必须**建立证据边,把 decision 的主张和支撑它们的 task、fact 连接起来。
- **accept / reject / defer** —— 对提议的裁定(这就是那道门)。
- **supersede** —— 一个新 decision 推翻旧的;旧的被 retire,而不是删除,历史因此得以保留。
- **amend** —— 修改推理过程,但不改变结论。
- **retire** —— 前提已经不成立的 decision 下线。
- **relate** —— 在 decision 与 task 或 fact 之间建一条类型化的边;证据就是这样被挂上去的。

## 证据是边,不是嵌入的数组

一个承重的 decision 进入集中存放的 `decisions/` 目录,它的证据被记录为**类型化的关系**——图里真实存在的边——而不是塞进文档 frontmatter 里的一个数组。这是刻意的设计:基于关系的 coverage(覆盖)意味着"这条主张能否从一个仍然存活的 fact 触达"是一个图查询,而不是数一数列表里有几项。

但这并不意味着 accept 是 coverage gate。accept 是判断门:只要某条主张至少有一条证据关系连到真实图实体,或者显式记录了 judgment-only 理由,decision 就可以进入 active。完整的逐主张覆盖检查发生在后续 reckon 和 milestone exit,那时 fact 已经产生。此时 checker 会对任何未覆盖的承重主张 fail closed。

## ADR 是一个投影,不是另一本平行账本

Architecture Decision Record(架构决策记录)和 decision 实体看起来几乎一样——两者都用上下文和后果去记录一个有理有据的选择。但它们处在不同的层次,一旦把两者的关系搞错,就会造成缓慢而昂贵的偏移。

规则是:**decision 实体是唯一的结构化真相来源。ADR 是它面向人类可读的投影——挂在 decision 上的证据,或者说是一个渲染出来的视图——绝不能成为另一本独立演化的账本。**

```text
decision entity  ──renders──▶  ADR
  (source of truth,             (readable narrative,
   holds ID, graph edges,        text-mentions the ID,
   lifecycle state)              inert — never writes back)
```

为什么不允许 ADR 变成第二本账本?因为同一个真实的选择如果写在两个权威的地方,迟早会出现分歧——到那时没人能说清哪个才是对的。decision 实体持有 ID、图上的边、生命周期状态;ADR 可以在文字里**提及**这个 decision 的 ID,但永远不会写回图里。当两者描述的是同一个选择时,decision 是权威版本,ADR 跟随它——被更新,或者被标记为 superseded,绝不会任由自己独自漂移。

## 靠搜索,不靠记忆

把这一切都做成结构化、集中存放、可引用的形式,而不是留在代理的工作记忆里,是有原因的:一个 decision 必须**可检索**,才谈得上被重用。一个你找不到的选择,就是一个你会重新做一遍的选择——很可能还做出不一样的结果。把 decision 放进一条可搜索的主干里,而不是指望代理凭记忆想起来,这才是让下一个代理能够站在上一个推理成果之上的原因。这条原则——靠搜索,不靠记忆——正是通向采用律的线索:
[05 · 采用律](05-adoption-law.md)。
