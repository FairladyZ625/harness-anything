# 流水线中的门

[门与 fail-closed](../../learn/zh/03-gates-and-fail-closed.md) 给出了一个承诺:没有任何承重写入能不经检查就溜进来,而安全的默认值是"否"。本页展示兑现这个承诺的机械装置——门在一个 task 的生命周期里位于何处、各自检查什么结构,以及为什么一次证据不足的状态迁移会被拒绝,而不是被放行。

## 门位于何处

门不是一份政策文档,而是生命周期迁移上的确定性校验,返回通过或一组阻塞问题。task 是沿生命周期
流转的实体——状态从 `planned`/`active` 推进到 `in_review`,最终进入终态 `done`。
迁移规则在 kernel domain 层定义(`packages/kernel/src/domain/task-lifecycle-command-transitions.ts`、
`task-lifecycle-review-transitions.ts`),完成判定由
`packages/kernel/src/domain/completion-readiness.ts` 与 `closeout-readiness.ts` 计算;
daemon 侧的 RepoCell 编排提交流程、评审与完成(`packages/daemon/src/repo-cell-submit.ts`、
`repo-cell-completion.ts`、`task-completion-review.ts`、`repo-cell-review-lint.ts`),
应用服务在 `packages/application/src/task-lifecycle-service.ts`。CLI 只是把这些命令转发给
daemon 协议(`packages/cli/src/cli/thin-command-task.ts`)。

关键性质是**从构造上就 fail-closed**。完成判定收集一组 **blocker**;只要列表非空,
迁移就不会发生,task 的状态从不被写入。没有任何东西被"默认认为没问题"——一次迁移必须靠
交出一个空的 blocker 列表,才能挣得通行。

```text
active Execution(持有 lease)
    │  写实 closeout.md → ha task submit <id>
    ▼
[ doc sync + 从 closeout.md 派生 Submission packet ] ─ 拒绝 ─▶ (状态不变)
    │ submitted → in_review
    │  ha task code-doc reconcile <id> --path ...   (契约声明时)
    │  ha task declare-executor <id>
    │  ha task review-execution <id> ...
    │  ha task review-consent <id>
    ▼
[ approved Review · consent · 声明的 completionGates · closeout readiness ] ─ 拒绝 ─▶ (状态不变)
    │  ha task complete <id>
done  (终态——写入经由唯一写路径)
```

像 `done` 这样的终态,永远不是你可以直接设置的状态:`ha task transition` 的目标集合只有
`planned`/`active`/`blocked`/`cancelled`,进入 `in_review` 只能经 `ha task submit`,
进入 `done` 只能经 `ha task complete`。门栈无法靠"直接改字段"绕过。

## Fact 归属是 completion 门

依据 `dec_22E7895EB4642798B70ADFAC79`，task 完成前必须至少有一条 active 的
`task/<id> -> fact/F-<id>` `produces` 边,否则 completion readiness 报 `fact_missing`。
Fact 仍是显式、append-only 的观察；submit 与 review 都不会自动生成 Fact。
独立 fact 合法,但不满足 task 的完成门。

Fact 以单独的 `facts/F-<id>.md` 文档存储。交付证据仍属于 Execution 的 Submission packet,
不能为了凑数量而复制进 Fact。

## Submission 派生检查

`ha task submit` 不接受提交参数——它先把任务包做 doc sync,再从 `closeout.md` 派生
Submission(`packages/daemon/src/repo-cell-submit.ts`)。机械检查包括:

- Summary 必须点名**一个**交付 commit,或至少一个 `artifact:path@revision` 锚;
  多于一个 commit、零个锚、同一 artifact 路径重复,都是 `invalid_submission`。
- 具名 commit 必须在某个绑定或 canonical 仓库里已发布,且是某绑定工作区的 HEAD
  或已发布的合并 commit;`deliverables` 由 `git diff` 求出。
- `artifact:` 锚的路径必须有 center-accepted revision。
- `closeout.md` 仍是 preset 脚手架句时,`closeout_placeholder` 拒绝。

重复提交同一份 closeout 返回已存回执;内容变化则拒绝,须显式 `ha task submit --amend`。
submit 必须持有并原子释放该 Execution 的 active lease——lease 与提交权绑定,
不是任何调用者都能替别人交卷。

## review 门

对于 Execution 路径,`ha task review-execution` 写一份 `review/v1` 不可变记录:
`verdict`(`approved`/`changes_requested`/`dismissed`)、非空 `reason`、
`evidenceChecked[]`,并按 `submissionDigest` 绑定到那一轮提交
(`packages/kernel/src/domain/review.ts`)。评审独立性由 `settings.review-*` 与
`task-completion-review.ts` 把关;随后 `ha task review-consent` 以
`review-consent/v1` 把同意钉在同一份 review 与 submission digest 上。

对于没有 Execution 的 legacy task,评审面是任务包的 `review.md`。lint 把发现表解析成
结构化条目——每条带严重度(`P0`–`P3`)、`open` 与 `blocksRelease` 标记;只要有任何
既 open 又 release-blocking 的发现,就以 `release_blocking_finding` 拒绝
(`packages/daemon/src/repo-cell-review-lint.ts`,产出 `verifier-backed-review/v1`
契约)。格式错误的表本身就是拒绝,而不是被悄悄跳过。仍带初始模板的 `review.md`、
仍与已知模板指纹匹配的 `closeout.md`,一律视为未完成。

## completion 门

完成一个 task 是最严格的迁移,因为 `done` 是终态。`ha task complete` 解析选中
preset/profile 的 `completionGates`,执行 `completion-readiness.ts` 的确定性判定,
落实 review/consent 路径与 closeout readiness,最后才写 `done`。当前的 blocker 代码:

| blocker | 含义 |
|---|---|
| `projection_unknown` | 投影不可读,无法判定 |
| `execution_ambiguous` | 选中哪一轮 Execution 有歧义 |
| `actor_unauthorized` | 调用者无权完成此 task |
| `document_invalid` | 必需文档缺失或校验失败 |
| `not_in_review` | task 不在 `in_review` |
| `task_blocked` | task 处于 blocked |
| `executor_missing` | 未声明 executor(`ha task declare-executor`) |
| `closeout_placeholder` | closeout 仍是脚手架 |
| `review_missing` | 缺 approved Review |
| `consent_missing` | 缺 review-consent 记录 |
| `ci_missing` | 契约声明 `ci` 但无见证绿 run(`settings.ci.workflows`、`ha ci observe pull`) |
| `code_doc_missing` | 契约声明 `code-doc-reconciliation` 但缺已验证 witness(`ha task code-doc reconcile`) |
| `gate_witness_missing` | 其他声明门的 canonical checker 见证缺失 |
| `decision_lineage_missing` | 承重 decision 谱系未闭合 |
| `lease_held` | 仍有未释放 lease |
| `doc_sync_required` | 有待同步的撰写文档 |
| `fact_missing` | 无 active `produces` fact 边 |
| `fact_retirement_undeclared` | fact 退役未声明 |

对于适用的 Execution,`ha task code-doc reconcile <task-id>` 会从唯一 submitted
execution 的 deliverables 自动取 execution、commit、iteration 与公开仓路径,对着拥有该
commit 的 Git 仓库验证路径,再发布 typed witness。已复核的 report-only submission
若声明的交付物全是任务包工件,可以直接完成,不必伪造公开仓路径。

只要任一 blocker 存在,task 就原地不动;而且因为 `done` 是一次承重写入,这次写入本身要走
[写路径](02-write-path.md)里描述的唯一写者,所以被接受的迁移会留下一条持久、可追溯的痕迹。

开发本地 gate 时还有一个操作层陷阱：`ha` 二进制跑的是已构建的 CLI 输出，不是 TypeScript 源码。
一扇门合入源码，并不等于当前本地二进制已经执行这扇门；在调用 `ha task complete` 测新门或改过的门
之前，必须先重建 `packages/cli/dist`。

## 三扇具名的门,作为机制

learn/03 按名字介绍了三扇门。它们不是三个同名函数,而是三处机械装置的意图层叫法;
这里说明每扇门在当前代码里到底对应什么。

**Exit Gate。** 对应上文的 completion readiness:`ha task complete` 前的整张 blocker 表——
承重的 decision 谱系闭合(`decision_lineage_missing`)、review 与 consent 就位、
声明的 completionGates 各有见证、closeout readiness 为 `ready`/`passed`。
账本完整性不是感觉,而是 canonical 事件的 append 记录,详见
[出处与事件](06-provenance-and-events.md)。

**Usability Gate。** 针对一个已交付的能力:一个全新的 agent,只拿到自描述的表面信息
(`--help` 与 capabilities 清单),必须能把它端到端跑通。被测的结构是发现路径——
命令是否把自己广而告之、入口是否找得到。

**Disposition Guard。** 对应 `packages/kernel/src/domain/entity-kind-registry.ts` 的
disposition 矩阵:每种实体声明支持哪些退出动作(`retire`、`supersede`、`invalidate`、
`archive`、`tombstone`、`hard-delete`)以及为什么其余不支持。decision 的纠正是
supersede 关系而不是删除;fact 的退出是 `invalidate`——以追加一条取代记录表达,而不是
物理移除,因为可能有东西依赖它来追溯出处。

## 为什么是这个形状

这里的每一扇门都共享一个形状:收集问题,让一个非空列表挡住迁移。这就是 fail-closed 用代码写出来的样子。门不负责定义"完成"应当是什么意思——它所核对的那个分层标准,是[采用律](../../learn/zh/05-adoption-law.md)的主题。门的职责更狭窄、更机械:给定一个标准,把默认答案设成"否",让一次迁移靠"身后不留任何未解决的问题"来挣得它的"是"。
