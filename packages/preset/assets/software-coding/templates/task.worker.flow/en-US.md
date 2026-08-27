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
- Submit receipts only through `ha doc sync --submit --path tasks/<pkg>/artifacts/reports/<file>.md`.
