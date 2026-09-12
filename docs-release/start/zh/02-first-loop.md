# 你的第一个完整闭环

在临时 Git 仓库里完成 `ha init` 后，运行这一页配方。规范回环是：

```text
Fact → Decision → Task → Fact
```

下列回执片段来自 2026-09-12 的隔离 Ubuntu fixture；你的 ID 会不同。所有写入仍经
center 单写队列，不要拿别人的工作区做示例。

## 开始之前

用拥有工作区的人类身份初始化一次：

```bash
ha init --person-id owner --display-name "Loop Owner"
```

预期：`ok=true command=repo-bootstrap`。不要把 `HARNESS_ACTOR` 设成人类值；daemon 会
认证 socket owner。agent 自动化可以为自己的命令设置 `HARNESS_ACTOR=agent:<id>`。

## 1. 记录观察

```bash
ha fact record --statement "Repeated handoffs lose the reason for the work." --source "support-review-2026-09-12" --confidence high
```

预期：`ok=true command=fact-record factId=F-3C9EB45C status=accepted_durable`。
保存回执里的 Fact ID，不要从 statement 猜 ID。

## 2. 提议选择

```bash
ha decision propose --json-input '{"title":"Keep handoff reasons in the ledger","question":"How should handoff context survive between sessions?","riskTier":"medium","urgency":"medium","decisionClass":"ordinary","chosen":[{"id":"CH1","text":"Record reasons as facts before creating follow-up work","rationale":"Preserves provenance"}],"rejected":[{"id":"RJ1","text":"Keep reasons only in chat","whyNot":"Chat is not a durable ledger"}],"claims":[{"id":"C1","text":"Durable facts preserve handoff reasons","loadBearing":true}]}' --body $'## 背景\nRepeated handoffs lose their rationale.\n\n## 权衡\nDurable facts preserve provenance; chat alone does not.\n\n## 结论\nRecord the reason as a Fact before creating follow-up work.'
```

预期：`ok=true command=decision-propose decisionId=dec_... state=proposed`。packet 承载
机器字段；正文必须保留 `背景`、`权衡`、`结论` 三节。

## 3. 挂证据，再用人类批准接受

```bash
ha relation relate --source-ref decision/dec_.../C1 --target-ref fact/F-3C9EB45C --type evidenced-by --rationale "The observed handoff loss supports the durability claim." --expected-version 0
```

预期：`ok=true command=relation-relate relationId=rel_...`。这里指向 claim `C1`，不是
chosen option `CH1`；接受 decision 需要这条证据边，或明确的 judgment-only 理由。

```bash
ha decision transition in_effect dec_... --consent-by owner --consent-at 2026-09-12T08:00:00Z --consent-channel cli
```

预期：`ok=true command=decision-transition state=in_effect consentId=djc_...`。两个独立
条件已经可见：claim 证据和明确的人类批准。三个 consent flags 是一次原子输入，且
`--consent-by` 必须是已认证 principal。旧的 `ha decision accept` 是弃用 alias，不是
第二条工作流。

## 4. 创建由 decision 派生的 task

```bash
ha task create --title "Publish a durable handoff note" --preset docs-task
```

预期：`ok=true command=task-create taskId=task_... status=accepted_durable`。使用回执给出的
package path，把脚手架 `task_plan.md` 写实，再用 `ha doc sync --submit` 发布后才能 start。

```bash
ha relation relate --source-ref decision/dec_.../CH1 --target-ref task/task_... --type derives --rationale "The chosen durable-record path creates this work." --expected-version 0
```

预期：`ok=true command=relation-relate relationId=rel_...`。派生边从 chosen option `CH1`
出发；它与 `evidenced-by` 使用 claim anchor 的规则不同。

## 5. 开工、产生收口 Fact、提交

```bash
ha task start task_...
```

预期：`ok=true command=task-start executionId=exe_... status=accepted_durable`。`start` 会
取得 execution lease，之后的 task 写入必须由 holder 完成。

完成工作后，记录一条归属此 task 的新观察：

```bash
ha fact record --task task_... --statement "The handoff note is present in the task package." --source "tasks/task_.../closeout.md" --confidence high
```

预期：`ok=true command=fact-record factId=F-... status=accepted_durable`。这条新 Fact 才会
闭合回环；复用开头的 Fact 不算。

提交前填写 task 的 `closeout.md`：

```markdown
## Summary

Published the durable handoff note.

## Verification

Checked the submitted task package and closing Fact.

## Residual Risk

None known.

## Same Mechanism Elsewhere

Use the same Fact → Decision → Task → Fact cycle for the next handoff.
```

```bash
ha task submit task_...
```

预期：`ok=true command=task-submit transition.from=active/implementation transition.to=in_review/review`。
`submit` 会发布符合条件的 task 文档，包括 closeout；不要再手工提交私有 ledger Git。

## 6. 评审并带 owner consent 完成

独立 reviewer 针对已提交 execution 写入 verdict：

```bash
HARNESS_ACTOR=agent:loop-reviewer ha task review-execution task_... --review-id review-docs-loop --json-input '{"verdict":"approved","reason":"Independent reviewer checked the submitted closeout and result fact.","evidenceChecked":["fact/F-...","tasks/task_.../closeout.md"]}'
```

预期：`ok=true command=task-review-execution reviewId=review-docs-loop`。reviewer 不能与
execution 的 agent 相同。

```bash
ha task complete task_...
```

在 owner consent／上游 Fact disposition 仍缺失时，预期：`ok=false command=task-complete
code=fact_retirement_undeclared`。回执会点名仍需明确处置的上游 Fact，不要绕过。

```bash
ha task complete task_... --consent --fact-holds "F-3C9EB45C:The handoff-loss observation still holds after publishing this note."
```

预期：`ok=true command=task-complete transition.to=done/review status=accepted_durable`。
`--consent` 会原子地选中 approved Review 并记录 owner consent；`--fact-holds` 记录开头
那条证据为何仍然成立。

现在得到的是可查询的完整闭环，而不是 task 形状的聊天记录。下一步可读
[三原语内核](../../learn/zh/01-three-primitive-kernel.md)，或把[日常命令速记表](03-daily-commands.md)
放在手边。
