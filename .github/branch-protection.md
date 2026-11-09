# Branch Protection Policy

This repository accepts work through pull requests against `main`.

## Required Pull Request Flow

1. Create a `codex/` branch from the latest `origin/main`.
2. Keep public implementation and private planning evidence separated.
3. Open a pull request with the full repository PR template.
4. Wait for the required `rewrite-ci` pull request contexts to pass.
5. Resolve or explicitly route open P0/P1/P2 findings before merge.
6. After approval and passing required checks, enqueue the PR with `node tools/pr-merge.mjs`; the helper enables merge-commit auto-merge, waits for the merge queue, and performs branch cleanup after GitHub reports the merge.

## Required Checks

The `rewrite-ci` workflow is the required CI surface for pull requests. Pull
request checks are split by evidence tier so failures are attributable and PRs
do not pay for duplicate full-check matrix runs.

Required pull request checks must cover:

- quick-gates
- fast and contract tests
- integration tests
- architecture boundaries
- package policy
- GUI build smoke
`quick-gates` owns the merged typecheck, lint, supply-chain, dependency-policy,
test-selection, schema-closure, entity-id-links, derived-contracts,
canonical-event-compat, cost-budget, and Ubuntu smoke controls.
Platform coverage is required through `crlf-checkout` and the Ubuntu positive
controls inside `quick-gates`. The Windows platform smoke and Windows
first-run arm run on `main` pushes and the daily schedule under
`dec_7467B04DD9EFC2D18A656D2FB3`.

The platform smoke controls were added after Windows defects reached users
through a fully green pull request. Four of those defects (#1525, #1526,
#1538, #1588) were line-ending defects that reproduce on any host told to
convert, so `crlf-checkout` catches them on a Linux runner in every PR. The
Windows platform smoke and Windows first-run product flow run on `main` pushes
and the daily schedule, where both Windows arms remain visible without adding
their matrices to the PR merge path.

The full aggregate `npm run check` matrix runs on the scheduled nightly and
manual workflow dispatch. Main pushes run the tiered lanes plus the dedicated
clean-build and Windows smoke checks. The aggregate remains the release-grade
gate and covers typecheck, all node tests, boundaries, package policy,
schema/API/service gates, supply-chain, Legacy Intake smoke, and CLI package
smoke. Node 26 compatibility runs in the aggregate and the nightly
`node26-compatibility` lane only — every one of
its 25 real catches in 60 days was simultaneously caught by the Node 24
typecheck lane (decision dec_F5B2CBF8B45042B6DA2824A7FA/CH3).

The active GitHub repository ruleset is the sole enforcement surface for
`main`. It currently requires pull requests, the `rewrite-ci` status checks,
deletion blocking, and non-fast-forward/force-push blocking with no bypass
actors. The `check-github-required-contexts` gate verifies the hosted branch
rules against the structured gate manifest. After the owner enables the
`merge_queue` rule on an eligible organization-owned repository, GitHub's merge
queue will wait for the required checks on the temporary `merge_group` ref and
merge each pull request when the rules are satisfied. Until that rollout step,
the live ruleset has no `merge_queue` rule; this document describes the target
queue behavior and must not be read as evidence that hosted queue enforcement
is already active.

The active GitHub ruleset enforcement for `main` requires these status contexts:

- boundaries
- package-policy
- quick-gates
- fast-contract (1)
- fast-contract (2)
- fast-contract (3)
- fast-contract (4)
- integration-shard (1)
- integration-shard (2)
- integration-shard (3)
- integration-shard (4)
- integration-shard (5)
- integration-shard (6)
- integration-shard (7)
- integration-shard (8)
- integration-shard (9)
- integration-shard (10)
- integration-shard (11)
- integration-shard (12)
- integration-shard (13)
- integration-shard (14)
- gui-build
- pr-body-lint
- crlf-checkout (1)
- crlf-checkout (2)
- crlf-checkout (3)
- crlf-checkout (4)

Integration tests are required through the fourteen `integration-shard (N)`
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
