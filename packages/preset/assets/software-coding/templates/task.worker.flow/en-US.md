# {{title}} — Worker Flow

## Dispatch Goal

State the outcome this worker owns and what a successful handoff makes possible.

## Scope Boundaries

- In scope:
- Out of scope:
- Files or systems the worker may change:

## Inputs and Dependencies

- Required context and source material:
- Upstream decisions or tasks:
- Assumptions that must be verified:

## Acceptance Criteria

- [ ] The requested outcome is observable.
- [ ] Relevant tests or checks pass.
- [ ] Evidence is attached to the handoff.

## Stop Conditions

Stop and report when scope, authority, required input, or a destructive choice is unclear.

## Commit and Handoff

- Commit only files owned by this assignment.
- Report the commit, changed files, verification, and residual risks.
- Before handoff, rebase onto the latest `origin/main` and rerun the evidence commands.
- Submit task-bound receipts only through `ha doc sync --submit --task <task-id>`.
- For a repository delivery, publish with `ha task push <task-id>`, create the PR with `ha task pr <task-id>`, then wait for the CI verdict with `ha task ci <task-id> --wait` (`--json` for the full report, `--timeout <seconds>` to bound the wait); submit only after the delivery SHA is green. Workers never merge.
- `pending` and `not_started` are not verdicts: a not_started report names its reason — no pull request → open one with `ha task pr`; a conflicting pull request → rebase onto the base and push again; queued → keep waiting.
- When CI is red, run `ha task ci <task-id>` for the failed test, assertion, and full-log reference, and compare the same test on origin/main's latest CI: main-red failures are recorded in the report, not fixed and not waited on; every other red you judge as caused by this change, repair, push again, and read CI again until the delivery SHA is green.
