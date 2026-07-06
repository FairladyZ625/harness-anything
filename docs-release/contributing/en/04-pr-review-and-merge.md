# PR, review, and merge

## PR body format

Every public PR uses the repository template at `.github/pull_request_template.md`.
The body must contain two complete language blocks:

1. `# English`
2. `# 中文`

Do not write alternating paragraph-by-paragraph translations. The English block
is complete on its own; the Chinese block is complete on its own. The gate also
checks the PR gate checklist.

## Required PR content

Fill in:

- Summary.
- What Changed.
- Task And Scope.
- Version Impact.
- Verification.
- Review Evidence.
- Residual Risk.
- References.
- PR Gate Checklist.

If a section does not apply, say why. Do not delete template sections to make the
PR look shorter.

## Review evidence

Review evidence includes self-review, maintainer review, human review, reviewer
subagent output, and concrete bot comments on the PR. Treat review comments as
inputs that must be triaged, not as automatic truth and not as noise.

Any open P0/P1/P2 finding must be in one of these states before merge:

- fixed;
- explicitly false-positive with rationale;
- deferred with owner and reason;
- blocking.

Do not merge with an untriaged release-blocking finding.

## Bot comments

If Codex Connect Bot, ChatGPT Codex Connector, or another review bot leaves a
specific comment, include it in review triage. The bot is not the merge
authority, and the bot is not a substitute for CI. It is evidence to evaluate.

## Merge authority

External contributors and their agents do not merge PRs into `main`.

A PR may be merged only by a maintainer, the repository owner, or a
maintainer-authorized admin agent after:

- the branch is based on current `origin/main` or has been synchronized;
- required `rewrite-ci` PR lanes are green;
- the PR has no merge conflict;
- the PR body and checklist are complete;
- review evidence has been triaged;
- no open release-blocking P0/P1/P2 finding remains.

Maintainer-authorized admin merge is not a way to skip CI or review triage. It
is a controlled merge path after the gates are satisfied.

## Conflict handling

If the PR has a merge conflict, fix the PR branch by merging or rebasing from
`origin/main`, resolve the conflict, run the relevant checks again, and let CI
rerun.

Do not solve conflicts by force-pushing over `main`, direct-pushing to `main`, or
asking an agent to bypass branch protection.

## After merge

Branch cleanup is maintainer-owned unless a maintainer explicitly asks the
contributor to help. Public contribution is complete when the PR is merged or
closed with a clear reason, not when local code happens to work.
