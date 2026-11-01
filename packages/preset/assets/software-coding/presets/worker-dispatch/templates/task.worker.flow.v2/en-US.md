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

When scope, authority, required input, or a destructive choice blocks progress, use the injected `ha task escalate <task-id> --question "<question>" --option "<option>" --recommend "<recommendation>" --reason "<why blocked>"` command. Repeat `--option` for each choice. Do not leave a ruling request only in a report.

## Commit and Handoff

- Commit only files owned by this assignment.
- Describe the outcome and rationale, verification, and residual risks; commit and changed-file facts live in the frozen submission.
- Before handoff, rebase onto the latest `origin/main` and rerun the evidence commands.
- Task package documents are accepted with the submission; do not run a separate document sync for those files.
- For a repository delivery, run `ha task submit <task-id>` after the final code commit to freeze its delivery facts, then publish with `ha task push <task-id>`, create the PR with `gh pr create --head <task-id>`, and run `gh pr checks <task-id> --watch` until the current PR head's checks settle. Workers never merge.
- Use `# Worker Role` as the single source for task-delivery timing, work during pending checks, failure repair, and session handoff. CI remains a completion gate when the task contract declares it.
- If the pull request has a conflicting pull request state, rebase onto the latest `origin/main`, push again, and reread the checks.
