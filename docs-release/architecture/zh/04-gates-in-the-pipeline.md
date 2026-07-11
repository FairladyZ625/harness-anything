# 流水线中的门

[门与 fail-closed](../../learn/zh/03-gates-and-fail-closed.md) 给出了一个承诺:没有任何承重写入能不经检查就溜进来,而安全的默认值是"否"。本页展示兑现这个承诺的机械装置——门在一个 task 的生命周期里位于何处、各自检查什么结构,以及为什么一次证据不足的状态迁移会被拒绝,而不是被放行。

## 门位于何处

门不是一份政策文档,而是一个在**生命周期迁移**上运行、返回通过或拒绝的函数。task 是沿生命周期流转的实体——task 包上的一个状态字段,从进行中的工作推进到 review,最终进入终态 `done`。门的代码位于应用层(`packages/application/src/task-lifecycle-gates.ts`),由一个编排器(`packages/application/src/task-lifecycle-orchestrator.ts`)驱动;调用它们的 CLI 面是 `packages/cli/src/commands/core/task-gates.ts`。

关键性质是**从构造上就 fail-closed**。每个门函数会收集一组 **issues(问题)**。只要这个问题列表非空,迁移就不会发生——编排器返回一个携带这些问题的失败结果,task 的状态从不被写入。没有任何东西被"默认认为没问题"。一次迁移必须靠交出一个空的问题列表,才能挣得通行。

```text
active Execution
    │  ha task transition <id> in_review --completion-claim "..."
    ▼
[ submit：封存 bindings + 六字段 packet ] ─ 拒绝 ─▶ (状态不变)
    │ submitted
in_review
    │  ha task review-execution <id> ... --rationale "..."
    │  ha task complete <id> [--ci passed]
    ▼
[ approved Review · 声明的 completionGates · closeout ] ─ 拒绝 ─▶ (状态不变)
    │ 通过
done  (终态——写入经由唯一的写协调器)
```

像 `done` 这样的终态,永远不是你可以直接设置的状态。编排器会拒绝对终态的直接写入,转而让它走完成路径,于是整个门栈无法靠"直接改字段"绕过。

## Fact 晋升不是 completion 门

依据 `dec_mrg3z1we/CH4`，一个 task 可以有 `0..N` 条 Fact。Fact 是对承重观察的
显式、append-only 晋升；submit、review 和 complete 都不会自动生成 Fact。交付证据
属于 Execution outputs 与 Submission packet，不能为了凑数量而复制进 Fact。

因此，`facts.md` 缺失、为空或没有解析出任何 `F-` 记录，都不会阻止 review 或
completion。承重观察需要供未来 decision 或跨任务推理使用时，仍可显式记录为 Fact；
它不再是通用的 task completion 数量门。

## Submission 与 Evidence 检查

提交 active Execution 时，completion claim 必须非空，另外五个数组字段可以为空：
deliverables、Evidence refs、verification notes、known gaps、residual risks。这是可追溯的
检查锚点，不是“必须有文件”的证明形状；只有文字 claim、零条 Evidence 也合法（依据
`dec_mrg3z1we/CH1`、ADR-0027 D3）。

对每条 `OutputEvidence`，机器只检查四类事实：locator 存在或形状合法、Evidence 归属于
本 Execution、可选 SHA-256 匹配、可选 checker receipt 存在且绑定同一目标。机器不判断
相关性、正确性或充分性；这些属于 Reviewer，并由 `review/v2` 记录检查过的 Evidence ID 与
rationale（依据 `dec_mrg3z1we/CH2-CH4`、ADR-0027 D5-D6）。

## review 门

对于 legacy task，review 门检查 task 的 `review.md`。评审发现记在一张 Markdown 表里，门把这张表解析成结构化的发现，每条带一个严重度(`P0`–`P3`)、一个 `open` 标记和一个 `blocksRelease` 标记。

规则狭窄而机械:只要有任何一条发现**既 open 又 release-blocking**,review 就失败,每一条这样的发现都会以 `release_blocking_finding` 问题回报。只有当不再有 open 的阻断性发现时,门才发出一份通过的评审契约(`verifier-backed-review/v1`),概述看到了多少条发现,并确认 open 阻断项为零。一张格式错误的发现表——列数不对、severity 非法——本身就是一次拒绝,而不是被悄悄跳过;门不会读过一张它无法校验的表。

还有一个配套的占位符检查。一个仍带着初始"not-started"模板的 `review.md`,或一个仍与某个已知模板指纹匹配的 `closeout.md`,都会被视作**未完成**。门拒绝接受被打扮成结果的脚手架。

## completion 门

完成一个 task 是最严格的迁移，因为 `done` 是终态。`ha task complete` 会解析选中
preset/profile 的 `completionGates`，只执行其中声明的确定性门，同时落实适用 review 路径与
closeout readiness，最后才写入 `done`。legacy task 会重新运行 `review.md` 门；带 Execution
的 task 要求当前 Execution 已有 approved Review（ADR-0027 D5、D7）。

| 检查 | 通过要求 | 报告的失败码或 issue |
|---|---|
| legacy review 文档 | 不带 Execution 文档的 task 必须有 `review.md`，发现表必须能解析，且不能有 open 的 release-blocking 发现 | completion 报告 `review_not_passed`；底层 review 失败可能是 `review_document_missing`、`review_schema_invalid` 或 `release_blocking_findings` |
| Execution Review | 带 Execution 的 task 必须对当前 Execution 有 approved Review | Execution completion service 报告 Review 缺失或未批准 |
| review 占位符 | 初始 `review.md` 占位符必须被替换 | `review_placeholder` |
| closeout 占位符 | 配置了占位符策略时，`closeout.md` 不能匹配已知模板指纹 | `closeout_placeholder` |
| code-doc reconciliation | 解析出的契约声明 `code-doc-reconciliation` 时，task 包必须包含一份手写的 `code-doc-anchors.json`，其中有合法的承重记录，且每条记录至少有一个硬 commit 或 path 锚点 | `code_doc_reconciliation_failed`，issues 里可能包含 `code_doc_anchors_missing` |
| review 门轴 | 上面的 review 门通过后，completion 函数收到的 review 必须是 `passed` | `review_not_passed` |
| CI 门轴 | 解析出的契约声明 `ci` 时，CLI 传入的 CI 门必须是 `passed`；否则无需 `--ci` | `missing_ci_gate` 或 `ci_not_passed` |
| closeout 就绪度轴 | 投影出的 closeout readiness 必须是 `ready` 或 `passed` | `closeout_not_ready` |
| task tree dirty 检查 | 迁移清扫之后，`tasks/<id>/` 必须足够干净，让 lifecycle writer 可以提交 | `task_tree_dirty` |

解析出的契约声明这扇门时，code-doc reconciliation 文件不会由 `ha task create` 生成；它必须被
手写进 task 包，路径是 `harness/tasks/<id>/code-doc-anchors.json`（ADR-0027 D7）。文档 schema
是 `code-doc-reconciliation/v1`，每条
记录命名一个 task package `ledgerPath`、一个承重 `kind`（`closeout`、`evidence`、
`decision-claim` 或 `review`）以及一组 anchors。commit 与 path anchor 会对着本地 git 校验；PR
anchor 只有在同时携带 SHA 时才校验，否则只是 warning。没有任何硬 commit 或 path anchor 的记录，
即便写了 PR，也会失败。

只要任一检查失败，task 就原地不动。只有当完成路径返回一个空的问题列表后，task 才被写入 `done`——
而且因为 `done` 是一次承重写入，这次写入本身要走[写路径](02-write-path.md)里描述的那个唯一写
协调器，所以被接受的迁移会留下一条持久、可追溯的痕迹。

开发本地 gate 时还有一个操作层陷阱：`ha` 二进制跑的是已构建的 CLI 输出，不是 TypeScript 源码。
一扇门合入源码，并不等于当前本地二进制已经执行这扇门；在调用 `ha task complete` 测新门或改过的门
之前，必须先重建 `packages/cli/dist`。

## 三扇具名的门,作为机制

learn/03 按名字介绍了三扇门。这里说明每扇门到底在检查什么,描述在结构层面,而非意图层面。

**Exit Gate。** 当一整项工作被作为"已完成"提交时触发。它不信任那份宣布,而是检查其背后的结构。具体地说,三件事必须同时成立:承重的 decisions 都已解决(没有任何一个还开着)、task 链真正闭合(没有东西被阻塞或悬空)、发生过什么的事件账本完整。那个账本的完整性不是靠感觉——它是运行时事件的 append 记录,详见[出处与事件](06-provenance-and-events.md)。三者缺一即为拒绝。

**Usability Gate。** 针对一个已交付的能力触发。它检查一个可达性性质:一个全新的 agent,只拿到自描述的表面信息(`--help` 和能力清单),对这东西如何造出来毫无记忆,必须能把它端到端跑通。被测的结构是发现路径——命令是否把自己广而告之、入口是否找得到——而不是实现本身。一个能用却无法从 `--help` 找到的能力,过不了这道门,因为一个 agent 触达不到的能力,在机制上就等于未被采用。

**Disposition Guard。** 在删除时触发。它检查图上的**入边**。任何仍被引用的东西都受保护:被其他实体指向的 decision 永不物理删除——最多被 retire,让它的 id 和边保留下来;fact 永不被单独删除,因为可能有东西依赖它来追溯出处。这道守卫的检查是一个图问题——"还有东西指向它吗?"——如果答案是有,就拒绝销毁,转而提供归档。

## 为什么是这个形状

这里的每一扇门都共享一个形状:收集问题,让一个非空列表挡住迁移。这就是 fail-closed 用代码写出来的样子。门不负责定义"完成"应当是什么意思——它所核对的那个分层标准,是[采用律](../../learn/zh/05-adoption-law.md)的主题。门的职责更狭窄、更机械:给定一个标准,把默认答案设成"否",让一次迁移靠"身后不留任何未解决的问题"来挣得它的"是"。
