# Evidence discipline

## Treat reports and status as claims

An agent's summary, a successful exit code, a green label, a file listing, or a count is a claim about reality. Match it to an artifact and the question it is supposed to answer. Record what was observed, how it was observed, and what remains inferred.

For a code result, inspect the actual changed files and relevant callers. For behavior, run the path that distinguishes the expected result from its failure case. For structural claims, search both the intended new form and the old form that should be gone. For remote work, verify the exact commit, PR head, required checks, and review record on their authoritative systems.

## Test the measuring instrument

Before trusting a detector's silence, give it a positive control that should trigger. Before calling a failure unrelated, establish that the unchanged or pre-change side can pass under the same relevant conditions. A test that fails on both sides does not show that the patch caused the failure. When possible, include a negative control that must remain rejected.

If counts unexpectedly fall, pagination returns no rows, a scan finds nothing, or a status changes without a traceable event, first check the scope, cursor, filter, version, and detector itself. Silence is evidence only when the instrument's range is known.

## Separate observation from explanation

One symptom can have multiple causes at different layers. Keep the raw failure and exact command output. Change one relevant condition at a time when distinguishing causes. A successful retry after changing several things does not identify which change mattered.

Do not use a worker's confidence or a search result as ground truth. Verify high-impact claims at their source. Mark missing environments, inaccessible branches, unobserved model settings, and pending CI as unverified instead of inferring success.

## Choose evidence for the claim

| Claim | Useful evidence |
| --- | --- |
| Behavior is fixed | A discriminating reproduction or focused test that failed before and passes after, plus relevant regression coverage. |
| Caller is wired | A traced invocation path or real workflow reaching the changed behavior. |
| Old mechanism is removed | Searches for the old form, reads of remaining consumers, and tests for the replacement boundary. |
| Performance improved | Comparable measurements, workload, environment, and call or resource counts. |
| Remote delivery is ready | Exact PR head, all required checks complete and green, and required review/consent records present. |
| No other instance exists | Complete search scope, pagination or filters verified, and known positive control found. |

The evidence must match the statement. A local test does not prove CI, a screenshot does not prove behavior, and a green check does not prove user adoption.
