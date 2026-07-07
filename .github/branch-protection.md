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
- GUI Electron E2E smoke
- Node 26 compatibility for typecheck plus fast and contract tests

The full aggregate `npm run check` matrix runs on `main`, scheduled nightly, and
manual workflow dispatch. It remains the release-grade gate and still covers
typecheck, all node tests, boundaries, package policy, schema/API/service gates,
supply-chain, Legacy Intake smoke, and CLI package smoke.

GitHub repository rulesets for `main` should require pull requests, the
`rewrite-ci` status checks, deletion blocking, and non-fast-forward/force-push
blocking with no bypass actors. Classic branch protection keeps the same
required status checks with `required_status_checks.strict = false`, approval
count `0`, and required conversation resolution disabled. Mergify owns the
up-to-date guarantee by testing queued pull requests against the predicted
merge state.

The current GitHub branch-protection configuration for `main` has administrator
enforcement disabled and requires these status contexts:

- boundaries
- package-policy
- typecheck (24)
- typecheck (26)
- fast-contract
- integration
- supply-chain
- gui-build
- gui-e2e
- node26-compatibility
- pr-body-lint

The Mergify GitHub App must be installed from
https://github.com/marketplace/mergify before maintainers rely on the queue.
The queue rules live in `.mergify.yml`.

Mergify queue rules track the fast gate subset:

- boundaries
- package-policy
- typecheck (24)
- typecheck (26)
- fast-contract
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

The slower `integration`, `supply-chain`, `gui-build`, `gui-e2e`, and
`node26-compatibility` contexts remain GitHub branch-protection required
contexts even though they are outside the Mergify fast-gate subset.

This repository may leave classic administrator enforcement disabled so a
single-owner/admin-agent workflow can merge after recorded local review
evidence. The active ruleset still blocks force pushes, deletion, missing
required checks, and non-PR updates to `main`.

## Admin Bypass

Administrator merge is the normal autonomous path after local task evidence
records:

- verification commands
- self-review
- reviewer review
- residual risks
- the latest `origin/main` sync state

Bypass does not make checks, conflict resolution, or review evidence optional.
