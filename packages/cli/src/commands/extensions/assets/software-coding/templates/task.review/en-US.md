# Review

Status: not-started

Record the actual review result before closeout; initial not-started with no findings blocks task-complete. Review produces a task verdict (PASS/FAIL), not a decision primitive. If review exposes a load-bearing route choice, then run `ha decision propose ...`.

E75: before review, the task must have a real fact; if missing, first run `ha record fact --task <task-id> ...`.

## Reviewer

- Agent: pending
- Mode: read-only review before merge

## Findings

| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
