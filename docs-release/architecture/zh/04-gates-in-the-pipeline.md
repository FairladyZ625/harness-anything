# 流水线中的门

[门与 fail-closed](../../learn/zh/03-gates-and-fail-closed.md) 给出了一个承诺:没有任何承重写入能不经检查就溜进来,而安全的默认值是"否"。本页展示兑现这个承诺的机械装置——门在一个 task 的生命周期里位于何处、各自检查什么结构,以及为什么一次证据不足的状态迁移会被拒绝,而不是被放行。

## 门位于何处

门不是一份政策文档,而是一个在**生命周期迁移**上运行、返回通过或拒绝的函数。task 是沿生命周期流转的实体——task 包上的一个状态字段,从进行中的工作推进到 review,最终进入终态 `done`。门的代码位于应用层(`packages/application/src/task-lifecycle-gates.ts`),由一个编排器(`packages/application/src/task-lifecycle-orchestrator.ts`)驱动;调用它们的 CLI 面是 `packages/cli/src/commands/core/task-gates.ts`。

关键性质是**从构造上就 fail-closed**。每个门函数会收集一组 **issues(问题)**。只要这个问题列表非空,迁移就不会发生——编排器返回一个携带这些问题的失败结果,task 的状态从不被写入。没有任何东西被"默认认为没问题"。一次迁移必须靠交出一个空的问题列表,才能挣得通行。

```text
进行中的工作
    │  ha task review <id>
    ▼
[ fact 门 ] ─ 拒绝 ─▶ (状态不变)
    │ 通过
    ▼
[ review 门 ] ─ 拒绝 ─▶ (状态不变)
    │ 通过
in_review
    │  ha task complete <id> --ci passed
    ▼
[ fact 门 ] · [ completion 门 ] ─ 拒绝 ─▶ (状态不变)
    │ 通过
done  (终态——写入经由唯一的写协调器)
```

像 `done` 这样的终态,永远不是你可以直接设置的状态。编排器会拒绝对终态的直接写入,转而让它走完成路径,于是整个门栈无法靠"直接改字段"绕过。

## fact-record 门

最具体的生命周期门,也是最严格的一个,值得直白地说清楚,因为它是纯粹的机制。

**一个 task 不能进入 review 或 completion,除非它的 `facts.md` 里至少有一条真实的 `F-` fact 记录。**

在编排器内部,`reviewTask` 和 `completeTask` 都会在做任何别的事之前先调用 fact 门。它解析出 task 本地的 `facts.md`,从中读出 fact 记录,如果文件缺失——或存在但一条记录都没有——迁移就以 `task_fact_required` 错误失败。门交回来的修复提示是字面的:

```text
Task review and completion require at least one real F- fact record.
Add one with:
  ha fact record --task <id> --statement "<verified result>" \
    --source "<evidence path or command>" --confidence high
```

fact 记录是 append-only 的,带一个 `F-` id、一条 `statement`、一个 `source` 和一个 `confidence`。这道门从结构上强制的是:一项工作不能在**没有任何可验证内容**的情况下被宣布为可评审。在工作被允许推进之前,账本上必须至少有一条被记录、带来源的观察。宣布的成本很低;一条带来源的 fact 不是。

## review 门

一旦 task 至少有了一条 fact,review 门就去检查 task 的 `review.md`。评审发现记在一张 Markdown 表里,门把这张表解析成结构化的发现,每条带一个严重度(`P0`–`P3`)、一个 `open` 标记和一个 `blocksRelease` 标记。

规则狭窄而机械:只要有任何一条发现**既 open 又 release-blocking**,review 就失败,每一条这样的发现都会以 `release_blocking_finding` 问题回报。只有当不再有 open 的阻断性发现时,门才发出一份通过的评审契约(`verifier-backed-review/v1`),概述看到了多少条发现,并确认 open 阻断项为零。一张格式错误的发现表——列数不对、severity 非法——本身就是一次拒绝,而不是被悄悄跳过;门不会读过一张它无法校验的表。

还有一个配套的占位符检查。一个仍带着初始"not-started"模板的 `review.md`,或一个仍与某个已知模板指纹匹配的 `closeout.md`,都会被视作**未完成**。门拒绝接受被打扮成结果的脚手架。

## completion 门

完成一个 task 是最严格的迁移,因为 `done` 是终态。completion 门从 task 的投影行里读出若干条轴,要求它们全部对齐:

| 轴 | 通过要求 |
|---|---|
| review 门 | 必须为 `passed` |
| CI 门 | 必须为 `passed` |
| closeout 就绪度 | 必须为 `ready` 或 `passed` |

如果 review 门未 passed、CI 未 passed,或 closeout 就绪度弱于 ready,completion 门就返回问题(`review_not_passed`、`ci_not_passed`、`closeout_not_ready`),task 原地不动。只有当门返回一个空的问题列表后,task 才被写入 `done`——而且因为 `done` 是一次承重写入,这次写入本身要走[写路径](02-write-path.md)里描述的那个唯一写协调器,所以被接受的迁移会留下一条持久、可追溯的痕迹。

## 三扇具名的门,作为机制

learn/03 按名字介绍了三扇门。这里说明每扇门到底在检查什么,描述在结构层面,而非意图层面。

**Exit Gate。** 当一整项工作被作为"已完成"提交时触发。它不信任那份宣布,而是检查其背后的结构。具体地说,三件事必须同时成立:承重的 decisions 都已解决(没有任何一个还开着)、task 链真正闭合(没有东西被阻塞或悬空)、发生过什么的事件账本完整。那个账本的完整性不是靠感觉——它是运行时事件的 append 记录,详见[出处与事件](06-provenance-and-events.md)。三者缺一即为拒绝。

**Usability Gate。** 针对一个已交付的能力触发。它检查一个可达性性质:一个全新的 agent,只拿到自描述的表面信息(`--help` 和能力清单),对这东西如何造出来毫无记忆,必须能把它端到端跑通。被测的结构是发现路径——命令是否把自己广而告之、入口是否找得到——而不是实现本身。一个能用却无法从 `--help` 找到的能力,过不了这道门,因为一个 agent 触达不到的能力,在机制上就等于未被采用。

**Disposition Guard。** 在删除时触发。它检查图上的**入边**。任何仍被引用的东西都受保护:被其他实体指向的 decision 永不物理删除——最多被 retire,让它的 id 和边保留下来;fact 永不被单独删除,因为可能有东西依赖它来追溯出处。这道守卫的检查是一个图问题——"还有东西指向它吗?"——如果答案是有,就拒绝销毁,转而提供归档。

## 为什么是这个形状

这里的每一扇门都共享一个形状:收集问题,让一个非空列表挡住迁移。这就是 fail-closed 用代码写出来的样子。门不负责定义"完成"应当是什么意思——它所核对的那个分层标准,是[采用律](../../learn/zh/05-adoption-law.md)的主题。门的职责更狭窄、更机械:给定一个标准,把默认答案设成"否",让一次迁移靠"身后不留任何未解决的问题"来挣得它的"是"。
