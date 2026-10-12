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
- For a repository delivery, publish with `ha task push <task-id>`, create the PR with `ha task pr <task-id>`, read CI with `ha task ci <task-id> --json`, and submit only after the delivery SHA is green. Workers never merge.
- When CI is red, run `ha task ci <task-id>` first and use its failed test, assertion, and full-log reference before repairing the code.
