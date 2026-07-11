# Review

Status: not-started

Record the actual review result before closeout; initial not-started with no findings blocks legacy `ha task complete`. An Execution Review produces `approved`, `changes_requested`, or `dismissed`, not a decision primitive. If review exposes a load-bearing route choice, run `ha decision propose ...` (ADR-0027 D5).

For an Execution round, `review/v2` records the inspected `evidence_checked` IDs (possibly none), a non-empty semantic rationale, findings, and one of `approved`, `changes_requested`, or `dismissed`. Locator, digest, ownership, and checker-receipt checks are mechanical inputs, not a sufficiency verdict (dec_mrg3z1we/CH3-CH4; ADR-0027 D5-D6). Facts remain explicit `0..N` promotions; do not copy delivery Evidence into Facts to satisfy review.

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
