# Branch Protection Policy

This repository accepts work through pull requests against `main`.

## Required Pull Request Flow

1. Create a `codex/` branch from the latest `origin/main`.
2. Keep public implementation and private planning evidence separated.
3. Open a pull request with the full repository PR template.
4. Wait for the `rewrite-ci` workflow to pass.
5. Resolve or explicitly route open P0/P1/P2 findings before merge.
6. Delete the merged PR branch after merge.

## Required Checks

The `rewrite-ci` workflow is the required CI surface for pull requests. It must
cover:

- aggregate check
- typecheck
- unit and contract tests
- architecture boundaries
- package policy
- schema contracts

GitHub branch protection for `main` should require pull request review and the
`rewrite-ci` status checks. This repository may leave administrator enforcement
disabled so a single-owner repository can still merge after recorded local
review evidence. Any admin bypass must be explicit in the task evidence and PR
body.

## Admin Bypass

Administrator bypass is only acceptable after local task evidence records:

- human approval for the bypass
- verification commands
- self-review
- reviewer review
- residual risks
- the latest `origin/main` sync state

Bypass does not make review optional.
