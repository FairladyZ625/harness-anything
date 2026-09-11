# 治理闭环操作配方

这是 Fact → Decision → Task 闭环的可复制路径。请在临时 Git 仓库中使用打包 CLI
和隔离 `HOME`；绝不要让测试连接 default daemon。以下回执来自 2026-09-11 的打包
CLI 实跑；请将其中 ID 替换为你本次输出的 ID。

```bash
npm pack --workspace @harness-anything/cli --pack-destination "$PWD/.recipe-pack"
```

坑：必须在 worktree 打包，不要在 canonical checkout 打包；把 tarball 安装到空
prefix。

```text
harness-anything-cli-0.0.1.tgz
```

```bash
export HOME="$PWD/.ha-home" HARNESS_GIT_AUTHOR_NAME="Your Name" HARNESS_GIT_AUTHOR_EMAIL="you@example.com"
ha init --person-id you --display-name "Your Name"
ha daemon status
```

坑：人类归属由 daemon 认证，不要设置 `HARNESS_ACTOR=human:you`。status 必须显示
隔离 `userRoot`，绝不能是正常的 `~/.harness`。

```text
initialized harness at harness/harness.yaml
outcome: applied
daemon status: pid=<pid> repos=1 entry=dist commit=<commit>
target: endpoint=/tmp/harness-anything/<socket> daemonId=default userRoot=<scratch>/.ha-home/.harness repoId=<repo-id> canonicalRoot=<scratch>
```

```bash
ha task create --json-input '{"title":"Implement the recipe","workKind":"docs","riskTier":"low","urgency":"low"}'
ha task start task_e984b4eb7d6a54eb1c44cbe9e7
```

坑：创建只写脚手架，不会生成可执行计划。新 task 会刻意拒绝未写实计划；先写计划
并经 `ha doc sync --submit` 提交，这不是 lease 失败。

```text
created task task_e984b4eb7d6a54eb1c44cbe9e7 at tasks/task_e984b4eb7d6a54eb1c44cbe9e7-implement-the-recipe
preset: standard-task/baseline
error code=plan_placeholder hint=Required-section diagnostics:
- Brief: still contains scaffold text “One-line statement of the task objective and scope.”
[...其余必填节也会逐项列出...]
Edit harness/tasks/task_e984b4eb7d6a54eb1c44cbe9e7-implement-the-recipe/task_plan.md, then run ha doc sync --submit --path tasks/task_e984b4eb7d6a54eb1c44cbe9e7-implement-the-recipe/task_plan.md and retry.
```

```bash
ha fact record --task task_e984b4eb7d6a54eb1c44cbe9e7 --statement "The packed CLI runs in an isolated HOME." --source "recipe run" --confidence high
```

坑：`--statement` 与 `--text` 二选一；`--source` 必填。

```text
schema=fact-row/v1 ref=fact/F-16E9FECB taskId=task_e984b4eb7d6a54eb1c44cbe9e7 statement=The packed CLI runs in an isolated HOME. confidence=high
acceptance: accepted_durable; git: pending; projection: verified
```

```bash
ha decision propose --json-input '{"title":"Use the packed CLI","question":"Which command path should the recipe use?","riskTier":"low","urgency":"low","decisionClass":"ordinary","chosen":[{"id":"CH1","text":"Use the packed CLI"}],"rejected":[{"id":"RJ1","text":"Use the workspace CLI","whyNot":"It is guarded outside the canonical checkout."}],"claims":[{"id":"C1","text":"The packed CLI can run in the isolated repository.","loadBearing":true}]}' --body $'## Background\n\nThe recipe must not use the default daemon.\n\n## Decision\n\nUse the packed CLI.\n\n## Impact\n\nThe commands run in an isolated HOME.'
```

坑：`chosen` 是 `{id,text}` 对象数组，每个 claim 都需要布尔值 `loadBearing`；接受
前正文必须具备三个标题。

```text
chosen:
CH1  Use the packed CLI
claims:
C1  The packed CLI can run in the isolated repository.  true
schema=decision-row/v1 decisionId=dec_B4D8A89380D163D7168CD3977C state=proposed
```

```bash
ha relation relate --source-ref decision/dec_B4D8A89380D163D7168CD3977C/C1 --target-ref fact/F-16E9FECB --type evidenced-by --rationale "The run produced this observation." --expected-version 0
ha decision claim fulfill dec_B4D8A89380D163D7168CD3977C --id C1 --mode evidenced
ha decision accept dec_B4D8A89380D163D7168CD3977C --rationale "The recorded fact supports the claim."
```

坑：evidence 路径同时需要关系和单独的 claim fulfill；两者完成后 `accept` 才能通过
（另一条路径是 `--judgment-only`）。

```text
schema=relation-action-history/v1 relationId=rel_aab341acca8329ed eventType=relation_created aggregateRevision=6
C1  The packed CLI can run in the isolated repository.  true  evidenced
schema=decision-row/v1 decisionId=dec_B4D8A89380D163D7168CD3977C state=in_effect
```

```bash
ha task submit task_e984b4eb7d6a54eb1c44cbe9e7 --json-input '{"completionClaim":"Implemented","deliverables":["docs-release/start/zh/05-governance-recipe.md"],"outputs":["commit:<sha>"],"verificationNotes":["npm run check"],"knownGaps":[],"residualRisks":[],"commitSha":"<sha>"}'
ha task complete task_e984b4eb7d6a54eb1c44cbe9e7 --ci receipt_recipe
```

坑：`verificationNotes` 必须是数组；submit 需要通过非占位计划取得的 active lease。
`complete --ci` 接受的是 canonical receipt reference，不是自由文本。

```text
error code=lease_required hint=Validation failed for entity=task task_e984b4eb7d6a54eb1c44cbe9e7 field=lease; actual=no matching active lease for the authenticated actor
error code=invalid_command hint=Task complete could not select one current closeout execution.
```

提交已启动的 task 前，先为 `closeout.md` 写实并同步，且必须恰有：

```markdown
## Summary
## Verification
## Residual Risk
## Same Mechanism Elsewhere
```

接着由不同 reviewer actor 使用 `ha task review-execution`，再使用
`ha task review-consent` 并传入 review/content digest。本次特意保留新 task 的
`plan_placeholder` 拒绝，因此这两个命令在该实跑中不可达。

```bash
ha daemon stop
```

坑：仅在配方结束后停止隔离 daemon。

```text
daemon-stop: applied
```

## 当前与后续命令

本次打包 CLI 尚没有 `decision preflight`、`task preflight` 或
`--from-closeout`。C1/C2/C3 伴随任务可能会添加它们；发布后再更新本页。
