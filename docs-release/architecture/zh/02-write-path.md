# 唯一的写入路径

[门与 fail-closed](../../learn/zh/03-gates-and-fail-closed.md) 给出了一个承诺:没有任何承重写入能不经检查就溜进来,而且这样的写入只能经过**一扇门**。本页展示这扇门背后的机械装置——写协调器(write coordinator),以及那个为每一次被接受的写入盖章、落盘、提交的写日志(journal)。

## 一扇门,由构造保证

承重写入——创建 task、推进它的生命周期、追加进度、提议或接受 decision——都不会直接触碰磁盘。它们统一经过唯一的组件**写协调器**,其接口 `WriteCoordinator` 定义在 `packages/kernel/src/ports/write-coordinator.ts`。这个接口刻意做得很小:

```text
WriteCoordinator
  enqueue(op)  -> WriteAck     把意图记进 journal
  flush(reason)-> FlushReport  落盘、提交、盖水印
  recover      -> RecoveryReport  重放任何做到一半的写入
```

调用方能做的每一件事都表达为一个 `WriteOp`:一个 `opId`、一个 `entityId`、一个 `kind` 和一份 payload。`kind` 取自一个封闭枚举——task 类(`package_create`、`transition_local`、`progress_append`、`doc_write`、`package_archive`、`package_delete_hard` 等)、decision 类(`decision_propose`、`decision_accept`、`decision_reject`、`decision_relate`、`decision_retire` 等)、fact 类(`fact_invalidate`),以及 module 类。这里根本没有"把这些字节写到那个路径"这种原语。一个操作只要不属于枚举内的某个 kind,就进不了系统。

调用方甚至不用手工构造 op。`packages/kernel/src/write-coordination/write-helpers.ts` 里的辅助函数(`writeCoordinatedTaskDocuments`、`writeCoordinatedPayload`)负责组装 op、推导它的 `opId`、入队并 flush——于是所有通往持久化存储的路径,都收束成同一个两步动作:**先 enqueue,再 flush**。

本地 CLI 写入还必须带着显式的 actor 归因进门。CLI 会在创建协调器之前解析它：
`HARNESS_ACTOR=agent:<id>` 与 `HARNESS_ACTOR=system:<id>` 仍是有效环境通道；human 身份则
必须使用 `--actor human:<id>`，因为子进程会继承环境变量。显式 flag 优先于环境变量。
本地写入也需要 git author 的姓名与邮箱；示例使用 `HARNESS_GIT_AUTHOR_NAME`、
`HARNESS_GIT_AUTHOR_EMAIL`（对应的 Git author 环境变量可以 fallback）。归属或 author 数据
缺失、格式不正确时，本地写入不能继续。journal 会记录 actor 来自 `env` 还是 `flag`。daemon
写入走已认证的 human actor 路径，记录 `source: daemon`，并要求该身份能解析出 git author
邮箱。详见[归属模型](../../actor-attribution.zh-CN.md)。

## Journal:先意图,后效果

具体的协调器是**带 journal** 的实现,位于 `packages/kernel/src/store/write-journal-coordinator.ts`(`makeJournaledWriteCoordinator`)。它把每一次写入拆成两个阶段,好让任何一处崩溃留下的都是可恢复的状态,而不是损坏的状态。

**Enqueue** 记录的是*意图*。它校验 op,跑一遍预检(preflight),然后把描述这个 op 的一条 journal 记录追加进一个只追加(append-only)的 journal 文件。op 的 payload 被单独写成一个按内容寻址的 blob,记录里带着一个 `payloadHash`,这样 payload 在真正被应用之前,可以逐字节地被校验。此时授权目录(authored tree)里什么都还没变——只有 journal 知道有一次写入即将发生。

**Flush** 产生的是*效果*。它在一把仓库锁下,读取持久化的 journal 状态,过滤出尚未应用的记录,逐条应用到磁盘,把被触碰的路径提交到 git,最后写下一个**水印(watermark)**。水印(`writeWatermarkDurably`)才是"已提交内容"的权威记录;journal 本身随后会被压实(compact),那只是一项优化,即便压实失败,flush 依然算成功——因为重放信任的是水印,而不是 journal。

```text
enqueue                          flush
  校验 op                          获取仓库锁
  预检(路径不冲突)                读取持久化 journal 状态
  写 payload blob + hash           对每条未应用的记录:
  追加 journal 记录                  校验 payload hash
  (磁盘不变)                        把 write op 应用到磁盘
                                    收集被触碰的路径
                                  把这些路径提交到 git
                                  写水印
                                  压实 journal(尽力而为)
```

## Execution 命令维护跨记录不变量

claim、submit、review、complete 都是领域命令，因为每个命令都要协调多条记录或多种
substrate。claim 先保留 runtime lease，再撰写 active Execution，并收敛部分失败；submit
校验 active holder，封存所有 Session binding 及其 capture interval，写入六字段 Submission
Packet，在同一个 authored batch 内改变 Execution 与 Task 状态，然后才释放 lease；review
为那一个 submitted Execution 追加不可变 Review（ADR-0027 D2-D5）。

这个顺序也划定 Evidence 边界。submit 路径可以机械检查 locator 是否存在、Execution 归属、
可选 digest 与可选 checker receipt；它不得从这些检查推导相关性、正确性、充分性或 Review
verdict（依据 `dec_mrg3z1we/CH3`、ADR-0027 D6）。

## 落盘的原子性:先写临时文件,再改名

单个文件的写入绝不会留下一个写了一半的文件。这个原语是 `packages/kernel/src/store/write-journal-durable.ts` 里的 `writeFileDurably`:它把完整内容写进一个唯一命名的临时文件(`.<pid>.<时间戳>.tmp`),`fsync`,然后用 `renameSync` 把临时文件盖到真实路径上,再 `fsync` 所在目录。因为 rename 是原子的,读取者要么看到旧文件、要么看到新文件——永远不会看到被截断的那种。journal 的追加本身用的是带 `fsync` 的追加(`appendJsonLineDurably`),所以一条记录在被算作意图之前,已经落到了稳定存储上。

同样的"先临时、后改名"模式,在任何"一次性整体替换某个工件"的地方都会重现——包括 SQLite 投影(见 [03 · 投影:从 Markdown 到 SQLite](03-projection.md)),它也是先构建进临时文件,再改名到位。

## 水印这一枚印章

每一次被接受的写入都会留下持久、可追溯的痕迹,而水印就是那道痕迹。这里有两种水印:

- **写水印**(`write-watermark/v1`)紧挨着 journal,记录 `lastCommittedOpIds`、`lastCommitSha` 和一个 `projectionHash`。协调器靠它在下一次运行时判断:哪些 op 已经做完、哪些还需要重放。
- **decision 水印**(`_coordinatorWatermark`)被盖进协调器写出的每一个 decision 文档的 frontmatter 里。因为它是*由*唯一写入路径写下的,它的存在与唯一性,就成了"这个 decision 文件确实走过了协调器,而不是被手写或复制粘贴出来"的证据。`packages/kernel/src/projection/post-merge-checks.ts` 里的合并后检查(`findDecisionWatermarkIssues`)会在一个 decision 缺失 `_coordinatorWatermark`、或两个 decision 共用同一个水印时,硬失败(hard-fail)。

decision snapshot 也可以把这个水印当成 compare-and-swap 守卫。一次 snapshot 写入可以携带
`expectedWatermark`；写路径会在替换文件之前读取当前 decision 水印。如果当前值与期望值不一致，
写入会以 `cas_watermark_mismatch` 被拒绝，并标记为可重试，不会改动任何文档。在 CLI 面，它通过
普通的 `write_rejected` 外壳呈现，而 CAS 原因是需要刷新后重试的 cause。

一扇门,意味着只有一处盖章;每一次被接受的写入盖一枚章,意味着每一条记录都能被追溯回产生它的那次操作。

## 提交是写入的一部分

提交到 git 不是一个"指望用户记得去做"的独立步骤——它就是 `flush` 的一部分。ops 一旦应用完毕,协调器就用一条生成的、有语义的提交信息(例如 `task(transition): <id> -> in_review [<opId>]`),精确地提交那些被触碰的路径。被提交的 op id 集合会被串进下一个水印,于是 git 历史和水印对"发生了什么"这件事达成一致。结果就是:真相之源(git 里的 Markdown)和已接受写入的账本,在同一把锁下步调一致地一起前进。

## 拒绝才是默认

写入路径自上而下继承了 fail-closed 的行为。校验(`validateOp`)会拒绝:`opId` 或 `entityId` 为空的 op、payload 不是对象的 op、没有理由的硬删除。预检(`preflightWriteOp`)会拒绝那些文档路径会互相冲突的写入。payload 校验会拒绝任何字节已不再哈希成所记录 `payloadHash` 的记录。对一个已归档、已终态、或仍有入边引用的 task,硬删除会被直接回绝(`assertHardDeleteAllowed`,它查的是 [Disposition Guard](../../learn/zh/03-gates-and-fail-closed.md) 所执行的同一套处置规则)。上面每一种情况,抛出的都是一次拒绝,而不是写下任何东西——安全的默认值是"否"。
decision CAS 不匹配也属于同一家族：一个过期的 expected watermark 会得到可重试的
`cas_watermark_mismatch`，而不是最后写入者获胜的覆盖。

## 崩溃恢复

因为意图和效果被拆开,而且两者都是持久的,一次被中断的写入不是"丢失或损坏的写入",而是一次*可重放*的写入。启动时 `recover` 会在同一把锁下,对水印尚未覆盖的 journal 记录重新跑一遍 `flush`。有两处细节让重放保持诚实:

- **非幂等的追加**(一次 `progress_append` 增量)在其文件变更落地的那一刻,就写下一行 `apply-marker/v1`。若崩溃发生在变更之后、提交之前,重放看到这个标记就跳过重写文本——但仍然会提交并给这个 op 盖水印,于是这条记录恰好完成一次。
- **Fact append delta** 有更窄的幂等规则。用同一个 `fact_id` 重放同一条格式化后的 `fact-record/v1`
  是 no-op；用同一个 id 重放不同字节，则作为重复记录被拒绝。
- **水印是权威。** 重放信任 `lastCommittedOpIds`,而绝不信任那份可能过期的 journal,来判断还剩什么要做。

回报,就是整个系统赖以立足的不变式:只有一扇门,这扇门为每一次放行的写入盖章并提交,而任何经过它的东西,都不会被留在残缺或无从追溯的状态里。
