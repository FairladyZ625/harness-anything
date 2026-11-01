# Verification and defect attribution

## Match checks to the claim

Write each acceptance statement as something observable. Choose a check capable of disproving it:

| Claim kind | Check shape |
| --- | --- |
| Runtime behavior | Run the real path with an input or state that distinguishes success from the known failure. |
| Structure or wiring | Trace the caller and search for both the required new form and forbidden old form. |
| Performance | Measure comparable workloads and report environment, sample, duration, and relevant call/resource counts. |
| Compatibility | Run the supported version/platform matrix that the change actually affects, or state the unverified entries. |
| Recovery or lifecycle | Exercise the public lifecycle and inspect the durable state and produced artifacts. |

Use repository-required checks and tests for the changed surface. A focused check is valuable evidence but does not replace a required broader gate. A check that cannot reach the caller does not prove integration.

## Establish causality

Preserve the original failure. Reproduce it before changing the code when possible. Compare a base or unchanged path under equivalent environment and configuration before deciding the patch is unrelated. Change one causal condition at a time. If two independent layers can cause the symptom, test which boundary rejects the bad state and which allows it through.

Do not increase retries, timeouts, or fallback behavior without showing which observed failure it addresses. A timeout may hide a stalled dependency; a retry can multiply side effects. Prefer an explicit state event, bounded wait, or corrected premise when that is the actual cause.

## Keep gates honest

Do not weaken an existing gate to turn a failing change green. If a test is invalid, show the false positive and a replacement that still catches the named failure. Before trusting a zero-result scan, validate its scope and use a positive control. For CI/local differences, compare exact commit, runner, environment, and configuration before assigning cause.

When a required tool or environment cannot be reached, record the raw limitation and mark that evidence unverified. Do not report an intended command as a test result.
