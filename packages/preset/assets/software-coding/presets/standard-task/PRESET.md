---
schema: preset-document/v1
description: Create the standard planning, facts, and closeout scaffold for general software work.
whenToUse: Use for ordinary implementation, maintenance, refactoring, documentation, or test work when no narrower preset fits.
---

# Standard Task

This is the default software-coding preset and the baseline for focused work that does not need a specialized workflow.

Declare `--risk-tier low` for a low-risk small change. When this preset declares
the short profile, the task automatically uses its minimal plan and closeout;
closeout requires no review or consent. It lifts no CI: a code change still
lands through the pull request's CI. Submit-time repository risk scripts may
raise the review route.

## Profiles

- `baseline` (default): `completionGates: []`, keeps lightweight/unverified flows unchanged.
- `lightweight`: minimal plan/closeout scaffold with `completionGates: []`.
- `verified`: enables the declarative `verification-receipt` completion gate.

## Verified Profile Receipt Template

Tasks created with `--profile verified` must submit `artifacts/verification-receipt.json`
matching the frozen cut before `ha task complete` can pass:

```json
{
  "commitSha": "<40-hex commit SHA, or null for artifact-only submissions>",
  "passed": 12,
  "failed": 0,
  "timedOut": 0,
  "unexecuted": 0,
  "total": 12
}
```

Requirements enforced by `standard-task/verify-receipt` and `software-coding/verification-receipt`:

- All six fields are required;
- `passed + failed + timedOut + unexecuted === total` and `total > 0`;
- `failed === 0`, `timedOut === 0`, and `unexecuted === 0` (no folded timeouts/skipped tests);
- For code submissions, `commitSha` must equal the frozen submission commit SHA;
- Missing, syntax-corrupted non-JSON, or extreme deep-nesting receipts exceeding V8 recursion depth settle as `unavailable` during host binding readout, while bounded-depth valid-JSON schema/type/SHA/count violations emit a `< 1024 B` UTF-8 `fail` witness; both block `ha task complete`.
