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
- For a repository delivery, publish with `ha task push <task-id>` and create the PR with `ha task pr <task-id>`. Read checks directly with your hosting-platform CLI and your own platform credentials; on GitHub use `gh pr checks <PR-number> --watch`. Submit only after the pushed delivery SHA is green. Workers never merge.
- Pending checks are not a verdict. On GitHub, use `gh run view <run-id> --log-failed` to inspect a failure and compare the same test on origin/main's latest CI: main-red failures are recorded in the report, not fixed and not waited on; every other red you judge as caused by this change, repair, push again, and read platform checks again until the delivery SHA is green. If the CLI cannot read checks, report the error and mark CI unverified.
- queued checks remain pending; keep waiting for a verdict.
- If the pull request has a conflicting pull request state, rebase onto the latest `origin/main`, push again, and reread the checks.
