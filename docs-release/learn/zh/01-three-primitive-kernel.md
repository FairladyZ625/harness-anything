# 三原语内核

内核,就是你拒绝让它继续膨胀的那部分。操作系统有内核,设计良好的类型系统也有。背后的想法是:一个小而正交的核心足以表达它之上的一切,而保持这个核心足够小,正是让整个系统长期保持可理解的关键。

这套系统的内核是三个原语——没有任何东西能与它们平起平坐。一切更大的东西(里程碑、标准、报告、roadmap)都是这三者的**组合**,而不是第四个原语。如果你没法用 decision、task、fact 组合出某样东西,第一反应不应该是去加一个新原语,而是追问:为什么组合不出来。

## 三个原语

每个原语回答不同的问题、用不同的时态、活在不同的地方。

| 原语 | 回答问题 | 时态 | 形式 | 生命周期 | 存储 |
|---|---|---|---|---|---|
| **Decision** | WHY / 应该 | 选择(与时间无关) | 一个可推翻的、有承载力的选择 | `proposed → accepted → active → retired / rejected / deferred` | 集中式,在顶级 `decisions/` 目录 |
| **Task** | WHAT / 进度如何 | 进行中(现在) | 一个状态机工作单元 | 6 个状态 + 9 个操作 | 在自己的任务容器内 |
| **Fact** | IS / 已经这样 | 完成(过去) | 一个不可变、仅追加的观察 | 无生命周期——只有 `record` / `invalidate` | `facts/` 中的独立记录，可选用关系边归属 task |

按列读这张表,设计意图就浮现出来了。**decision** 是一个"为什么",被冻结成一个你日后可以推翻的承诺。**task** 是一个"做什么"在流转中,拥有真实的状态——planned(规划中)、active(进行中)、blocked(阻塞)、in-review(评审中)、done(完成)、cancelled(取消)——以及在这些状态之间移动的操作。**fact** 是一个"是":生来不可变,永远不会再改。如果现实变了,你不会去改旧的事实,而是记录一个新的,需要的话再让旧的失效。

最后一行藏着一处重要的不对称。fact **并不是**和另外两个并排放着的生命周期机器。它只有一个创建动作——`record`——之后就冻结了。decision 和 task 是两台状态机;fact 则是它们运作所依托的、不可变的**底料**。

## 闭环

这三者不只是共存,它们在一个循环里彼此供给:

```text
   fact ──evidences──▶ decision ──derives──▶ task
    ▲                                      │
    └───────────────  produces  ───────────┘
```

- 先从现实中记录一个 **fact**（“这是我们观察到的情况”）。
- **decision**（“我们应该做 X”）把这个 fact 作为证据，并衍生出一个 **task**。
- **task** 执行后产生下一个 **fact**——带着出处的观察；它收口这一轮，并喂给下一轮 decision。

去掉任何一环,循环都闭合不了。没有 decision,fact 产生了却无人消费——池塘照样变绿。没有 task,decision 就落不了地变成工作。没有 fact,decision 就没有证据,没法被如实地评审。三者相互咬合,只有放在一起才自洽。

## 走一遍回环

按下面的顺序使用规范命令。每条命令都会写入图上的一部分，最后一条 fact 会成为下一轮的输入：

1. `ha fact record --statement "<observation>" --source "<source>" --confidence high` 记录初始的不可变观察。
2. `ha decision propose --json-input '<decision-packet.json contents>'` 创建 decision，让其中的主张可以由这条观察支撑。
3. `ha decision relate <decision-id> --anchor <claim-id> --type evidenced-by --target fact/F-XXXXXXXX --rationale "<why this fact supports the claim>"` 把 fact 挂到 decision 的主张上。
4. `ha task create --title "<work selected by the decision>"` 创建由 decision 选定的可执行任务包。
5. `ha decision relate <decision-id> --anchor <claim-id> --type derives --target task/<task-id> --rationale "<why this task follows>"` 记录 decision 到 task 的衍生关系边。
6. `ha fact record --task <task-id> --statement "<result>" --source "<verification>" --confidence high` 记录任务结果并闭合回环。

## 不对称的存储:task 归属由边表达

这是最容易搞错的地方。三个原语**不等于**三个对称的顶级文件夹。

- **Decision 是集中存放的。** 它们是主干——是唯一一个应该让人类盯着看的投影。所以它们住在一起,放在 `decisions/` 里。
- **Task 是容器。** 每个 task 都是一个自带工作文档的包。
- **Fact 是独立记录**,每条位于 `facts/F-<id>.md`,以 `fact/F-<id>` 标识。task 产生它时,
  由一条 active 的 `task/<id> -> fact/F-<id>` `produces` 边表达归属。

独立存储不会丢掉出处。fact 自身仍记录观察来源和 provenance；可选的 `produces` 边表达它归属
哪个 task,用于完成门和导航。没有宿主 task 的独立 fact 也合法,之后可以直接被 decision 引用。

观察通过被**引用**获得跨 task 的重要性。decision 可以指向任何 canonical fact 引用,无论它是否有宿主 task。

约束是"**身份独立,归属用边表达**"。decision 留在 `decisions/` 里,fact 留在 `facts/` 里,关系图承载跨实体语境。

三个原语各有清晰的存储位置,关系图作为引用总线。为什么要这么切分?两个性质因此自然成立:

- **可审计性**——fact 始终焊死在让它有意义的那个具体情境里,所以它的出处永远不会漂移。
- **低耦合**——不需要把任何东西物理聚拢就能建立相关性。相关性表达为图上的边,而不是文件夹里的成员关系,所以不管关系网怎么增长,存储结构都保持稳定。

## 边落在哪里

原语之间的类型化关系,是让整个系统运转起来的脉络。coverage(覆盖)、review(评审)、cleanup(清理),做的都是沿这些边的图遍历:*一个 decision 里每一条承重的主张,是否都能触达至少一个仍然存活的支持性 fact?* 这是一个可达性问题,答案要在 Markdown 的可重建投影上求得,而不是靠扫描文字。

"**选择一条路**"和"**判断某个输出是否成立**"之间的这层区别,足够微妙,值得单独用一章来讲。这就是 **decision** 和 **verdict** 的区别,接下来这一章就讲它:
[02 · 决策 vs 裁决](02-decision-and-verdict.md)。
