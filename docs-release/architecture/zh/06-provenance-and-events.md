# 出处、裁决与事件账本

[决策 vs 裁决](../../learn/zh/02-decision-and-verdict.md) 划下了一条硬线:decision 回答*我们走哪条路?*,verdict 回答*这个具体的输出成立吗?*——把两者混为一谈,会让其中一个悄悄吞掉另一个。本页展示把它们分开的机械装置,以及它们所依赖的两种记录结构:把记录绑定到产生它的那次运行的会话身份,以及 Exit Gate 用来核对完整性的那本 append-only 事件账本。

## 出处:每条记录都能指回它的来源

可归因性有两层。底层是 canonical 事件信封:每条被接受的事件都携带 `actor`
(`principal` 人 + 可选 `executor` agent)与 `source`——不存在匿名落盘的记录。
上层是文档面把会话身份显式写出来:decision 的 frontmatter 携带 `provenance[]`,而且
**恰好一条**——`SessionProvenanceV1`
(`packages/kernel/src/domain/agent-runtime.ts`):

| 字段 | 含义 |
|---|---|
| `runtime` | 产生它的运行时名(`claude`、`devin`、`codex` 等,非空字符串) |
| `sessionId` | 执行写入的那个会话(可为 null) |
| `transcriptReachability` | 该会话 transcript 的可达性(`by_session_id`、`dispatch_stream_only` 等) |
| `boundAt` | 这次绑定被盖章的时间戳 |

决策要求恰好一条会话身份:一条记录的出处要么能指回一次真实运行,要么不存在——
多条来源会让"谁拍板"变得含糊。task 包的归属由 `task-contract.json` 与文档属主声明承载;
fact 由 `Evidence source` 与 `Observed at` 承载;每条事件信封上的 `actor`/`source`
兜底,让任何实体都能沿 canonical 日志找回写它的人。

## 裁决:是一个判断,不是一个 decision 实体

**verdict（裁决）**是 Reviewer 对某个 submitted Execution 的语义判断。`review/v1`
(`packages/kernel/src/domain/review.ts`)的封闭值域是 `approved`、
`changes_requested`、`dismissed`,并且必须记录非空 `reason` 与 `evidenceChecked[]`;
它还带 `submissionDigest`,把裁决钉在被评审的那一轮提交上——换个提交就得重审。
Reviewer 读取 Task intent、closeout 派生的 Submission Packet 与可用工件后裁决这一轮
(依据 `dec_mrg3z1we/CH3-CH4`、ADR-0027 D5-D6)。`review-consent/v1` 再把同意钉在
同一份 review 与 submission digest 上。

值得着重强调的结构性事实，是 verdict **不是** decision 实体。它拿不到 `dec_` 式 id，
不进入 decisions 目录，也不上 decision 队列。它落在绑定到被判断 Execution 的不可变 Review
Entity 中，留在那一轮交付旁边，而不是被提拔为塑造未来工作的长期选择（ADR-0027 D5）。

| | Decision | Verdict |
|---|---|---|
| 问题 | 走哪条路?(WHY) | 这一轮交付成立吗? |
| 记在哪里 | `decisions/` 里的一个 decision 实体 | 某个 Execution 的不可变 `review/v1` |
| 上 decision 队列? | 是 | 否 |
| 可推翻 | 后来的 decision 能推翻它 | 一次性,默认 fail-closed |

## Session binding 与 Execution

Execution(`execution/v1`)携带 `sessionBindings`,记录这轮交付绑到了哪些 runtime
session;submit 封存 bindings 并固化 Submission。绑定里只保存 `transcriptRef` 这类
指针——能定位原 provider session,但不把 transcript 正文写进 canonical 日志(ADR-0027 D1)。

## 路由不是自动的

如果 verdict 不是 decision,那什么时候才会有 decision 从它里面产生?只有当这个 verdict 暴露出某种*战略性*问题时——"这批结果说明我们可能选错了路"。而即便到那时,路由也**不是自动的**。流水线里没有任何东西会自己把 `changes_requested` 变成新 decision。日常负面 verdict 只会阻止 acceptance，不会开出 decision；战略性 verdict 只是**促使**人刻意提出新 decision。

这正是 decision 队列之所以能保持有意义的机制性原因。如果每次日常裁决都自动创建 decision，队列会被逐条记账填满。把 verdict 留在与 Execution 绑定的 Review 记录里、把升级设成刻意步骤，日常 verdict 的洪水就到不了那条人类应该盯住的队列（ADR-0027 D5）。

## Agent Runtime 见证事件

Agent Runtime 事件是持久化的**生命周期变化见证**,不是原始活动流。`AgentRuntimeEventV1`
(`packages/kernel/src/domain/agent-runtime.ts`)与 task、document 事件复用同一个
canonical 信封、SQLite 事件台账与可重建投影。
它记录 installation 观察、session 生命周期变化、provider session 绑定,以及显式的 task/execution
绑定。绑定只保存 `transcriptRef`,因此可以定位原 provider session,但不会把 transcript 正文写入
canonical log。

heartbeat tick、stdout/stderr、transcript 正文、tool call 与 token/cost stream 都是 operational data,
不进入 canonical event。heartbeat 只有跨过 liveness 阈值、形成
`runtime_session_liveness_changed` 时才增长日志。runtime liveness 与 task lease/lifecycle 始终是两组
独立事实;session event 不能续租 lease,也不能完成 task。

daemon 会在本机 `.harness/runtime/dispatches/<dispatch-id>.jsonl` 留下 provider 的结构化事件流。
它是 operational evidence,不是数据库或 canonical event 内容：首行只关联 dispatch、task、runtime
session 与本地流引用，后续 JSONL 在需要查看时才解析。每条记录在写入前都会递归删除带敏感语义的
字段，并把可识别的 bearer/token 值替换为 `[REDACTED]`；credential、executable path 与 provider
环境值绝不会进入流文件。`ha task dispatches <task-id>` 合并正在运行的本地记录与已结束的 task
artifact；终态 dispatch artifact 保留流引用和 provider session id。因此
`ha runtime run --resume-dispatch <dispatch-id> --prompt "…"` 可以续跑，不必暴露或手工查找
provider session id。
续跑默认继承已记录的 agent、工作目录、permission mode 与 model。task worker 可用
`ha agent run <agent-id> --resume-dispatch <dispatch-id>`；换 agent 或再次续跑同一来源 dispatch
都会被拒绝。额度中断显示为 `provider_quota`；provider 给出重置时间时同时显示该时间，并在
`nextAction` 提供续跑命令。
leader 使用 `--agent <leader-id> --to <worker-id>` 时，同一条 dispatch artifact 还会记录声明的
`squadId`、worker `agentId` 与 `delegatedByAgentId`；目标必须属于该 leader 的 roster，且开放的
`runtimes` 集合必须包含封闭的实例 kind。

派活绑定 task 时,daemon 还会通过 canonical doc sync 发布终态工作产物。一次批量写入创建
`artifacts/missions/<dispatch-id>.md`、`artifacts/dispatches/<dispatch-id>.json` 与
`artifacts/reports/<dispatch-id>.md`。已写实的 `task_plan.md` 是唯一必需的 mission 来源：task start、
runtime 派工与 Squad 派工都会用同一个校验器拒绝必需节为空或仍保留 preset 脚手架句的 plan，错误码为
`plan_placeholder`。`ha agent run <agent-id> --task <id> --mission <name>` 会把 canonical
`artifacts/missions/<name>.md` 追加到 plan-derived mission；`--prompt` 仍是显式 override，而
agent 声明选择节点本地 instance 与 permissionMode；`--instance` 与 `--cwd` 只作本次覆盖。
`ha squad run --task <id>` 无需 prompt 即可派工。report 来自 provider 的结构化 runtime
result，绝不解析人类可读的终端输出。未绑定 task 的 runtime run 没有任务包，因此不会发布这些文档。

## 各部分如何相连

三种彼此独立的结构,一条问责的主干:

```text
provenance / actor   ──▶  每条记录写明产生它的那次运行与行动者
runtime witness      ──▶  task 与 execution 可以定位原生 session
execution verdict    ──▶  每个被判断的输出都被记录在工作旁边

一个战略性的 verdict → 由人提出一个新 decision(见 learn/02)
```

provenance 回答*谁产生了这条记录*。runtime witness 回答*见证的是哪个原生 session*。verdict 回答*这一个输出成立吗*。三者都不是 decision,也都不会悄悄变成 decision——从 verdict 升级到 decision 永远是一个刻意的人类动作,而这恰恰是让 decision 主干、以及盯着它的那个队列,始终值得一读的原因。这条分离背后的"为什么",是[决策 vs 裁决](../../learn/zh/02-decision-and-verdict.md)里的论证;它所汇入的那个"完成",则是[采用律](../../learn/zh/05-adoption-law.md)。

## 手写治理配置

手写的 `governance/walls/walls.json` 清单使用既有 doc-sync 整文件 JSON 策略。先运行 `ha doc status --path governance/walls/walls.json` 预览，再用 `ha doc sync --submit --path governance/walls/walls.json` 提交该路径。更新保留其它手写文档使用的 canonical cut 与内容校验。此分类不放行任意 JSON，也不替代 task contract、dispatch 记录的专用写入命令。
