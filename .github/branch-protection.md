# Branch Protection Policy

This repository accepts work through pull requests against `main`.

## Required Pull Request Flow

1. Create a `codex/` branch from the latest `origin/main`.
2. Keep public implementation and private planning evidence separated.
3. Open a pull request with the full repository PR template. Mergify-generated
   merge-queue verification pull requests are synthetic CI artifacts and do not
   replace the original pull request body.
4. Wait for the required `rewrite-ci` pull request contexts to pass.
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

The active GitHub repository ruleset is the sole enforcement surface for
`main`. It requires pull requests, the `rewrite-ci` status checks, deletion
blocking, and non-fast-forward/force-push blocking with no bypass actors. The
`check-github-required-contexts` gate verifies the hosted branch rules against
the structured gate manifest. Mergify owns the up-to-date guarantee by testing
queued pull requests against the predicted merge state.

The active GitHub ruleset enforcement for `main` requires these status contexts:

- boundaries
- package-policy
- typecheck (24)
- fast-contract
- integration-shard (1)
- integration-shard (2)
- integration-shard (3)
- integration-shard (4)
- integration-shard (5)
- integration-shard (6)
- supply-chain
- gui-build
- node26-compatibility
- pr-body-lint

The Mergify GitHub App must be installed from
https://github.com/marketplace/mergify before maintainers rely on the queue.
The queue rules live in `.mergify.yml`.

Mergify queue rules track the same required contexts as GitHub branch
protection. `merge_conditions` stays empty so Mergify can run in-place checks
against the queued pull request's predicted merge state.

- boundaries
- package-policy
- typecheck (24)
- fast-contract
- integration-shard (1)
- integration-shard (2)
- integration-shard (3)
- integration-shard (4)
- integration-shard (5)
- integration-shard (6)
- supply-chain
- gui-build
- node26-compatibility
- pr-body-lint

The `pr-body-lint` job checks human-authored pull request bodies against the
repository template. It narrowly skips Mergify synthetic queue verification pull
requests only when the pull request is authored by `mergify[bot]`, uses a
`mergify/merge-queue/*` head branch, and carries the Mergify queue payload
marker.

The `rewrite-ci` workflow may cancel superseded ordinary pull request runs, but
must not cancel `mergify/merge-queue/*` pull request runs. Mergify can emit
multiple queue-verification pull request events for the same synthetic branch,
and cancelled replacement races can make the queue treat otherwise passing
checks as failed.

When Mergify edits only the metadata body of a synthetic
`mergify/merge-queue/*` pull request, required jobs should complete with a
fast no-op success. That keeps queue bookkeeping edits from launching another
full CI pass while preserving normal `edited` body validation for
human-authored pull requests.

Integration tests are required through the six `integration-shard (N)`
contexts, not through a slower aggregate `integration` context.

GUI Electron E2E is an explicit local closeout gate for GUI-related tasks and
must be recorded as task evidence instead of running in GitHub CI.

## Admin Bypass

The active repository ruleset has no bypass actors. Repository administrators
cannot bypass required checks for `main`; merges still require recorded task
evidence, including:

- verification commands
- self-review
- reviewer review
- residual risks
- the latest `origin/main` sync state

Required checks, conflict resolution, and review evidence are not optional.
