# PR, review, and merge

The canonical body-building, production-delta, bilingual-lint, PR creation,
review-triage, and merge-handoff steps live in
[Prepare the bilingual PR body](../../../skills/harness-contributing/SKILL.md#prepare-the-bilingual-pr-body),
[Push and open the PR](../../../skills/harness-contributing/SKILL.md#push-and-open-the-pr),
and [Review and merge](../../../skills/harness-contributing/SKILL.md#review-and-merge).

## PR contract

The live [pull request template](../../../.github/pull_request_template.md) is
the body authority. Its English and Chinese blocks are independently complete;
machine-readable declarations stay in the location and format the template
specifies. Empty or deleted sections make a contribution harder to audit even
when a lightweight lint happens to accept them.

## Review responsibility

Self-review, human review, and concrete bot comments are evidence to triage.
They do not replace required CI, and a bot is not merge authority. Every open
P0/P1/P2 finding must be fixed, rejected with rationale, deferred with an owner
and reason, or left explicitly blocking before merge.

External contributors and their agents stop after the branch is current,
conflict-free, green, and reviewed. A maintainer owns the normal merge-commit
path and post-merge branch cleanup. Squash, rebase merge, direct pushes, and
admin bypass are not the standard contribution path.
