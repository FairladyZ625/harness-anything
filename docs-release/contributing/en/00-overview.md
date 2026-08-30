# Contributing overview

Harness Anything accepts public contributions through ordinary git review,
required GitHub CI, and maintainer-controlled merge. A useful contribution has
a narrow public scope, reproducible evidence, a complete bilingual PR, and no
private or machine-local context in its diff.

## The workflow authority

Install or load
[`harness-contributing`](../../../skills/harness-contributing/SKILL.md) in the
coding agent helping with the change. That skill is the repository's sole
executable path from issue scope through worktree, tests, manifest-selected
gates, PR-body validation, review triage, and merge handoff.

These pages explain the reasons and boundaries around that workflow. They do
not repeat its commands or maintain a second checklist. When wording here and a
current machine-readable repository surface differ, follow the skill's routing
to the live PR template, gate manifest, and package scripts.

## Where to start

- To implement an accepted issue or maintainer-approved change, start with the
  [contribution skill](../../../skills/harness-contributing/SKILL.md).
- To report a new public bug or documentation gap, use
  [Filing GitHub issues](06-github-issues.md) first.
- Before changing release or packaging claims, read
  [Release Posture](../../release-posture.md).

## Background pages

- [Local setup](01-local-setup.md) explains why the worktree and public/private
  boundaries exist.
- [Change flow](02-change-flow.md) records scope and architecture expectations.
- [CI and evidence](03-ci-and-evidence.md) explains the gate authority model.
- [PR, review, and merge](04-pr-review-and-merge.md) explains reviewer and
  maintainer responsibilities.
- [Agent contributors](05-agent-contributors.md) defines the agent evidence and
  authority boundary.

External contributors and their agents have proposal authority. They may
prepare and update a branch and PR, but final merge authority stays with
maintainers.
