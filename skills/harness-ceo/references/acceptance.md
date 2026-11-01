# Acceptance and completion

## Three acceptance layers

Keep three distinct questions separate:

| Layer | Question | Owner |
| --- | --- | --- |
| Functional review | Does the delivered change match its claim, preserve required invariants, connect to consumers, and pass the required checks? | Independent reviewer or delegated reviewer; CEO verifies important evidence. |
| Semantic acceptance | Does it solve the user's current problem, honor the governing request or decision, and add only justified responsibility? | CEO; cannot be delegated. |
| Usability acceptance | Can a person or fresh agent use the result through its real entry point without private session context? | Fresh-use check may be delegated; CEO confirms the required user path. |

CI green proves only the checks it actually ran. A review approval proves only the review's stated scope. Neither substitutes for semantic or usability acceptance.

## Re-read the source and search for omissions

For each submitted change, reread the request and current accepted design that define the intended outcome. Write the semantic acceptance points before reviewing code. Compare the exact submitted cut with those claims and with the real entry points. Do not derive requirements from the implementation or an old memory summary.

For a milestone or broad change, enumerate all active acceptance claims from their authoritative records. Walk from each claim to its implementation and use evidence. Look for omitted work, because omissions have no diff. For moves, removals, and migrations, search both the new target state and the old state that must disappear. Exclude claims explicitly superseded or deferred only after checking their live status.

When an audit worker reports drift, verify each material finding directly in the source and current records. The inventory is a useful input; its judgment is not a substitute for CEO ground-truth. If the user questions the meaning of a change, reopen it and inspect other work in the same delivery batch for the same missed condition.

For a broad audit, also sample entries the auditor marked satisfied and verify them from the same authoritative sources. This checks whether the audit method is systematically missing or reversing cases; it does not replace checking every reported blocker. Filter superseded or explicitly deferred claims only after confirming their current status and rationale.

## Prove real use

Trace the result through its actual caller, task, application route, or operator workflow. If a feature has no connected entry point, it is not usable delivery. Exercise the user-facing workflow in the task's required environment; for a documentation or CLI task, follow it from a clean context. Note limitations when the actual environment or a required persona is unavailable.

Before milestone closeout, check any existing issue or regression register for recurrence, then scan newly changed surfaces for newly introduced risks. A zero-finding result is acceptable only when scope and tools were capable of finding the named problems.

## Add milestone exit evidence

For a milestone, reconcile its authoritative checklist against the integrated state and close four evidence lenses:

1. **Structure:** required checks and assembly boundaries pass on the intended integrated version.
2. **Semantics:** the CEO walks every active claim from its source to the result, including omissions and replaced or removed paths.
3. **Adversarial and regression:** challenge the most consequential assumptions independently, recheck known defects for recurrence, and inspect the changed surface for new failures. A reviewer report is an input; verify material findings against source or behavior.
4. **Use:** demonstrate the representative user or operator path through the real entry point. A standalone artifact or test without that path is insufficient.

When safe and within the task's authorization, the CEO should also exercise the critical path directly and record concrete friction as evidence. Do not turn subjective satisfaction into an acceptance condition the user did not request. Report production adoption separately from a bounded usability demonstration.

## Bound review effort

Meet all review requirements frozen in the task and repository policy. Set additional review depth according to impact: protected boundaries, production writes, security, data changes, and hard-to-reverse behavior justify independent or adversarial review. Ordinary bounded work usually needs the required independent reviewer and focused evidence; pure prose can receive CEO review when its task contract permits it.

Tie findings to the exact cut. After a repair, verify confirmed findings and rerun only checks whose inputs changed, plus required gates. New findings must be classified: does the issue break a current invariant, production path, or acceptance criterion? If yes, resolve it before merge. If not, record a clear follow-up rather than expanding the current review indefinitely. Never weaken a required check to make the cut pass.

For suspected overengineering, ask the author for the simplest compliant solution, the extra complexity introduced, and the failure or capability it buys. Remove complexity that has no evidence-backed purpose.
