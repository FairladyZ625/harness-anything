# 治理闭环操作配方

以下是可复制执行的 Fact → Decision → Task → review 闭环。请在临时仓库中
使用打包 CLI，并设置隔离的 `HOME`；测试绝不要连接 default daemon。

```bash
npm pack -w @harness-anything/cli
```
坑：必须在 worktree 打包，不要在 canonical checkout 打包；把生成的
`harness-anything-cli-*.tgz` 安装到临时仓库。

```bash
export HOME="$PWD/.ha-home"; export HARNESS_GIT_AUTHOR_NAME="Your Name"; export HARNESS_GIT_AUTHOR_EMAIL="you@example.com"; ha init --person-id you --display-name "Your Name"
```
坑：人类归属由 daemon 认证，不要设置 `HARNESS_ACTOR=human:you`。

```bash
ha fact record --task task_<id> --statement "Observed behavior" --source "repro" --confidence high
```
坑：`--statement` 与 `--text` 二选一；`--source` 必填；事实不属于任务时
可以省略 `--task`。

```bash
ha decision propose --json-input '{"title":"Use the fix","question":"Which path?","riskTier":"low","urgency":"low","decisionClass":"standard","chosen":"Use the fix","rejected":"Do nothing","claims":[{"id":"C1","text":"The fix addresses the observation"}],"relations":[]}' --body-file decision-body.md
```
坑：JSON 必须包含五个必填字段和 `claims`；正文另传，且
`decision-body.md` 在接受前必须有 `## Background`、`## Decision`、
`## Impact` 三节。命令会输出新的 decision id。

```bash
ha decision accept dec_<id> --rationale "Evidence and review support this choice" --judgment-only "The recorded evidence is sufficient"
```
坑：接受是双条件：提供 claim-to-evidence 关系并完成 claim，或使用
`--judgment-only`；空 `appliesTo` 是警告，不是阻塞错误。

```bash
ha decision claim fulfill dec_<id> --id C1 --mode evidenced
```
坑：claim fulfill 与证据关系是两次独立写入；走 evidenced 路径时两者都要
完成，再执行 accept。

```bash
ha task create --json-input '{"title":"Implement the fix","workKind":"docs","riskTier":"low","urgency":"low"}'
```
坑：创建会生成任务包；后续命令都使用输出的 `task_<id>`。

```bash
ha task start task_<id>
```
坑：submit 需要 active execution lease；start 会获取或复用该租约。

```bash
ha task submit task_<id> --json-input '{"completionClaim":"Implemented","deliverables":["docs-release/start/zh/05-governance-recipe.md"],"outputs":["commit:<sha>"],"verificationNotes":["npm run check"],"knownGaps":[],"residualRisks":[],"commitSha":"<sha>"}'
```
坑：`verificationNotes` 是数组，不是字符串；七个字段都必填，且必须用
`--from-file` 或 `--json-input` 提供 packet。

```bash
ha task review-execution task_<id> --review-id review_<id> --json-input '{"verdict":"approved","reason":"Evidence checked","evidenceChecked":["commit:<sha>"]}'
```
坑：review 必须独立且带内容 pin；self-review 被拒时要换 reviewer actor。

```bash
ha task review-consent task_<id> --review-id review_<id> --consent-id consent_<id> --json-input '{"reviewDigest":"<digest>","contentDigest":"<digest>"}'
```
坑：consent 选择已记录的 review；两个 digest 必须与提交内容和 review 匹配。

```bash
ha task complete task_<id> --ci receipt_<id>
```
坑：complete 会检查 closeout 合同和 canonical CI receipt；`--ci` 是 receipt
引用，不是自由文本。

## Closeout 合同

在 submit/complete 前，让 `closeout.md` 精确包含以下四个标题：

```markdown
## Summary
## Verification
## Residual Risk
## Same Mechanism Elsewhere
```

反馈中的失败现在逐项可见：缺 `--rationale`（1）、未声明三元组（2）、缺决策
授权（3）、关系方向错误（4-6）、正文占位符（7）、claim 未 fulfill（8）、
`appliesTo` 软警告（9）、缺 packet 输入（10）、缺租约（11）、
`verificationNotes` 为标量（12）、缺 closeout 标题（13）。准确参数以
`ha <domain> --help` 为准；上面命令来自打包 CLI 的 help 输出。

## 当前与后续命令

当前打包 CLI 没有 `decision preflight` 或 `task preflight`；可在适用处使用只读的
`ha decision validate <id>` 与 `ha task review <id>`。C1/C2/C3 伴随任务中的
preflight、triples、`--from-closeout` 改进尚未发布，本页按现状记录。
