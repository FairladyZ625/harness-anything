# Branch Protection Policy

This repository accepts work through pull requests against `main`.

## Required Pull Request Flow

1. Create a `codex/` branch from the latest `origin/main`.
2. Keep public implementation and private planning evidence separated.
3. Open a pull request with the full repository PR template.
4. Wait for the fast `rewrite-ci` gate to pass.
5. Resolve or explicitly route open P0/P1/P2 findings before merge.
6. Let Mergify merge through the queue, then delete the merged PR branch.

## Required Checks

The `rewrite-ci` workflow is the required CI surface for pull requests. Pull
request checks are split by evidence tier so failures are attributable and PRs
do not pay for duplicate full-check matrix runs.

Required pull request checks must cover:

- typecheck
- fast and contract tests
- integration tests
- architecture boundaries
- package policy
- GUI build smoke
- Node 26 compatibility for typecheck plus fast and contract tests

The full aggregate `npm run check` matrix runs on `main`, scheduled nightly, and
manual workflow dispatch. It remains the release-grade gate and still covers
typecheck, all node tests, boundaries, package policy, schema/API/service gates,
supply-chain, Legacy Intake smoke, and CLI package smoke.

GitHub branch protection for `main` should require pull request review and the
`rewrite-ci` status checks, with `required_status_checks.strict = false`.
Mergify owns the up-to-date guarantee by testing queued pull requests against
the predicted merge state.

The Mergify GitHub App must be installed from
https://github.com/marketplace/mergify before maintainers rely on the queue.
The queue rules live in `.mergify.yml`.

Mergify blocks queue merges on the fast gate:

- boundaries
- package-policy
- typecheck (24)
- typecheck (26)
- fast-contract
- pr-body-lint

The slower `integration`, `supply-chain`, `gui-build`, and
`node26-compatibility` checks still run for visibility, but they do not block
the Mergify queue merge.

This repository may leave administrator enforcement disabled so a single-owner
repository can still merge after recorded local review evidence. Any admin
bypass must be explicit in the task evidence and PR body.

## Admin Bypass

Administrator bypass is only acceptable after local task evidence records:

- human approval for the bypass
- verification commands
- self-review
- reviewer review
- residual risks
- the latest `origin/main` sync state

Bypass does not make review optional.
