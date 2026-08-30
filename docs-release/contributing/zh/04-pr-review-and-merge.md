# PR、审查与合入

标准 PR body、production delta、双语 lint、创建 PR、review triage 与 merge handoff
步骤统一放在
[Prepare the bilingual PR body](../../../skills/harness-contributing/SKILL.md#prepare-the-bilingual-pr-body)、
[Push and open the PR](../../../skills/harness-contributing/SKILL.md#push-and-open-the-pr)
和 [Review and merge](../../../skills/harness-contributing/SKILL.md#review-and-merge)。

## PR 合同

实时 [pull request template](../../../.github/pull_request_template.md) 是正文权威。英文块和
中文块各自完整；机读声明必须保留在 template 指定的位置和格式。即使轻量 lint 偶然接受，
空白或删掉的 section 仍会破坏可审计性。

## Review 责任

self-review、human review 和具体 bot comment 都是需要 triage 的证据，不能代替 required
CI，bot 也没有合入权。合入前，每个 open P0/P1/P2 finding 都必须已修复、带理由判为
false positive、带 owner/理由延期，或明确保持 blocking。

外部贡献者及其 agent 在 branch 已同步、无冲突、全绿、review 完成后停下。普通 merge
commit 和合入后 branch cleanup 由 maintainer 负责。Squash、rebase merge、直推和 admin
bypass 都不是标准贡献路径。
