# Review

Status: not-started

Record the actual review result before closeout; initial not-started with no findings blocks `ha task complete`. Review produces a task verdict (PASS/FAIL), not a decision primitive. If review exposes a load-bearing route choice, then run `ha decision propose ...`.

E75: before review, the task must have a real fact; if missing, first run `ha fact record --task <task-id> ...`.

## Reviewer

- Agent: pending
- Mode: read-only review before merge

## D8 Stop Condition Checklist

- [ ] If the task is not CI/gate/governance work, review confirms no CI/gate authority surface was modified to make the task pass.
- [ ] If a CI/gate authority surface was modified, review confirms the task or PR body cites the authorizing ADR, decision, or task.
- [ ] If break-glass was used, review confirms reason, scope, and follow-up governance task are recorded.

## Findings

| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
