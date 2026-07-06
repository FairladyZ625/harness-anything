# Contributing overview

Harness Anything is built for agent-shaped work, but contributions still move
through ordinary git review, CI, and maintainer authority. A good contribution is
not just a patch that works locally. It is a patch with a clear scope, recorded
evidence, a reviewable PR, and no private context leaking into the public repo.

This path is the contribution contract for this repository. Read it before
opening a PR, and give it to any coding agent that helps you.

## The contribution path

1. Prepare a source checkout and use a branch or worktree.
2. Keep the change inside one reviewable scope.
3. Run the checks that match the scope.
4. Open a PR with the full bilingual template.
5. Triage review comments and CI failures.
6. Wait for maintainer-controlled merge.

The last step matters: external contributors and their agents may propose
changes, but they do not merge them into `main`. Merge authority stays with the
maintainers, the repository owner, or a maintainer-authorized admin agent after
the required gates pass.

## What this path covers

- [Local setup](01-local-setup.md): runtime, install posture, branch discipline,
  and public/private file boundaries.
- [Change flow](02-change-flow.md): how to shape a contribution so it can be
  reviewed and tested.
- [CI and evidence](03-ci-and-evidence.md): local commands, CI lanes, test
  tiers, and what must be recorded in the PR.
- [PR, review, and merge](04-pr-review-and-merge.md): the PR template, review
  evidence, bot comment triage, and merge authority.
- [Agent contributors](05-agent-contributors.md): rules for coding agents that
  work on this repository.

## Public scope only

Public contributions belong in the public monorepo: `packages/`, `tools/`,
`.github/`, root configuration, root README files, package README files, and
`docs-release/`.

Do not include local planning records, private evidence folders, generated
caches, local agent entry files, credentials, absolute filesystem paths, or
machine-specific state. If a private note helped you make a change, summarize
the public reasoning in the PR instead of copying the private note.

## Release posture

The current public release posture is source checkout and package smoke, not a
published npm package or signed desktop artifact. Before changing install,
packaging, or release wording, read [Release Posture](../../release-posture.md)
and keep the docs honest about what is shipped, foundation-only, and planned.

## The short version

Make the smallest coherent change, prove it with the right checks, fill the PR
template honestly, and leave merge control to maintainers. If your agent cannot
explain the scope, the verification, and the merge boundary, it is not ready to
open the PR.
