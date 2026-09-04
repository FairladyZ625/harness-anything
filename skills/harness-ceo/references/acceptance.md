# Acceptance and completion

## Three questions

| Question | Evidence | Responsibility |
| --- | --- | --- |
| Does the result implement its claim? | Diff, direct checks, outputs, error paths | Worker and optional independent reviewer; parent verifies claims |
| Does the claim match the requested outcome? | Original request and current accepted decisions compared with assembled behavior | CEO final semantic acceptance |
| Can the intended consumer use it? | Actual entrypoint and a representative usage path | CEO, with delegated cold-start evidence when useful |

CI proves its tested properties, not agreement with every design decision. A
reviewer's statement is an input until checked. A missing search result is not
proof of absence: inspect the search scope and real consumers. Exclude superseded
or explicitly deferred requirements before reporting drift. Zero findings is valid.

For milestones, enumerate requirements from the authoritative source toward the
implementation, not only from changed files backward. This finds missing work
that never produced a diff. Check removed and replacement paths when removal is
part of the contract. Reuse existing regression evidence for known failure modes;
add checks only when they discriminate a relevant failure.

## Bounded review

Scale review to the real uncertainty and impact. Low-risk work may be verified by
the CEO. Use independent review for meaningful risk or when repository rules demand
it; multiple perspectives are useful only when they test different assumptions.
Reviewers receive original sources and a neutral question, not the desired verdict.
Follow host/repository requirements for transport-bound actor independence; another
prompt to the same actor is not an independent approval.

Ground findings in evidence and resolve them as fixes, supported dismissals,
explicitly owned deferrals, or blockers. Recheck changed behavior and confirmed
findings; do not demand endless rounds without new evidence. Required checks and
release-blocking findings remain binding. Do not weaken a gate to accept work.

## Honest stage boundaries

Report implemented, verified, integrated, released, and adopted separately. A
successful local test does not mean released; a shipped feature does not prove
adoption. Actual adoption is a completion requirement only if the user's contract
requires it. A bounded cold-start exercise can verify usability without pretending
to be production usage. Do not make completion depend on subjective satisfaction
or unrequested polish.

In Git work, follow the repository's scoped verification and commit handoff. In
Git-less work, use central artifact/execution evidence. After authorized integration,
verify the changed assembled state and record the required task lifecycle writes.
Local deliverables may be ready while central submission or independent consent is
blocked: identify that exact stage rather than falsely marking the task done.

Release, cleanup, and retirement belong in completion when requested. Remove only
owned, superseded paths within authorization; do not delete another active checkout
or a user's customized matrix. Preserve useful failure evidence in the canonical
record. Finish with outcome, evidence, and material gaps rather than an activity log.
