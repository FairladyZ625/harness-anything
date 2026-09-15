# Gates in the pipeline

[Gates and fail-closed](../../learn/en/03-gates-and-fail-closed.md) makes a
promise: no load-bearing write slips in unchecked, and the safe default is
"no." This page shows the machinery that keeps that promise — where gates sit
in a task's life, what structure each one inspects, and why an insufficiently
backed transition is rejected rather than waved through.

## Where gates live

A gate is not a policy document; it is deterministic validation on a lifecycle
transition that returns pass or a set of blockers. Tasks are the entities that
move through a lifecycle — status advances from `planned`/`active` into
`in_review` and finally into the terminal `done`. Transition rules are defined
in the kernel domain layer
(`packages/kernel/src/domain/task-lifecycle-command-transitions.ts`,
`task-lifecycle-review-transitions.ts`); completion is judged by
`packages/kernel/src/domain/completion-readiness.ts` and
`closeout-readiness.ts`. Daemon-side RepoCell modules orchestrate submission,
review, and completion (`packages/daemon/src/repo-cell-submit.ts`,
`repo-cell-completion.ts`, `task-completion-review.ts`,
`repo-cell-review-lint.ts`), and the application service lives at
`packages/application/src/task-lifecycle-service.ts`. The CLI merely forwards
these commands to the daemon protocol
(`packages/cli/src/cli/thin-command-task.ts`).

The important property is *fail-closed by construction*. Completion collects a
set of **blockers**; a non-empty list means the transition does not happen and
the task's status is never written. Nothing is "assumed fine" — a transition
earns its way through by producing an empty blocker list.

```text
active Execution (holding the lease)
    │  realize closeout.md -> ha task submit <id>
    ▼
[ doc sync + Submission packet derived from closeout.md ] ─ reject ─▶ (status unchanged)
    │ submitted -> in_review
    │  ha task code-doc reconcile <id> --path ...   (when the contract declares it)
    │  ha task declare-executor <id>
    │  ha task review-execution <id> ...
    │  ha task review-consent <id>
    ▼
[ approved Review · consent · declared completionGates · closeout readiness ] ─ reject ─▶ (status unchanged)
    │  ha task complete <id>
done  (terminal — write goes through the single write path)
```

A terminal status like `done` is never a status you can set directly:
`ha task transition` only targets `planned`/`active`/`blocked`/`cancelled`;
`in_review` is reached only through `ha task submit`, and `done` only through
`ha task complete`. The gate stack cannot be bypassed by "just setting the
field."

## Fact ownership is a completion gate

Under `dec_22E7895EB4642798B70ADFAC79`, a task must have at least one active
`task/<id> -> fact/F-<id>` `produces` edge before completion, or readiness
reports `fact_missing`. A Fact is still an explicit, append-only observation;
submit and review do not synthesize one. Standalone facts are valid, but they
do not satisfy a task's completion gate.

Facts are stored as individual `facts/F-<id>.md` documents. Delivery evidence
still belongs to the Execution's Submission packet rather than being copied
into Facts to satisfy a count.

## Submission derivation checks

`ha task submit` takes no submission arguments — it doc-syncs the task package,
then derives the Submission from `closeout.md`
(`packages/daemon/src/repo-cell-submit.ts`). The mechanical checks:

- The Summary must name **one** delivery commit, or at least one
  `artifact:path@revision` anchor; more than one commit, zero anchors, or a
  repeated artifact path is an `invalid_submission`.
- The named commit must be published in a bound or canonical repository and be
  a bound worktree's HEAD or its published merge commit; `deliverables` come
  from `git diff`.
- Each `artifact:` anchor path must have a center-accepted revision.
- A `closeout.md` still carrying preset scaffold sentences rejects as
  `closeout_placeholder`.

Resubmitting an identical closeout returns the stored receipt; a changed
submission rejects and requires an explicit `ha task submit --amend`. Submit
must hold and atomically release the Execution's active lease — the lease is
bound to the right to submit, so no caller can hand in someone else's work.

## The review gate

On the Execution path, `ha task review-execution` writes an immutable
`review/v1` record: a `verdict`
(`approved`/`changes_requested`/`dismissed`), a non-empty `reason`, and
`evidenceChecked[]`, bound to that submission round by `submissionDigest`
(`packages/kernel/src/domain/review.ts`). Reviewer independence is enforced by
the `settings.review-*` configuration and `task-completion-review.ts`;
`ha task review-consent` then pins consent to the same review and submission
digests via `review-consent/v1`.

For a legacy task without Executions, the review surface is the package's
`review.md`. The lint parses its findings table into structured entries — each
with a severity (`P0`–`P3`), an `open` flag, and a `blocksRelease` flag; any
finding that is both open and release-blocking rejects as
`release_blocking_finding`
(`packages/daemon/src/repo-cell-review-lint.ts`, emitting a
`verifier-backed-review/v1` contract). A malformed table is itself a rejection,
not a silent skip. A `review.md` still carrying its initial template, or a
`closeout.md` still matching a known template fingerprint, counts as not done.

## The completion gate

Completing a task is the strictest transition, because `done` is terminal.
`ha task complete` resolves the selected preset/profile's `completionGates`,
runs the deterministic judgments in `completion-readiness.ts`, enforces the
review/consent path and closeout readiness, and only then writes `done`. The
current blocker codes:

| Blocker | Meaning |
|---|---|
| `projection_unknown` | the projection cannot be read to judge |
| `execution_ambiguous` | which Execution round is selected is ambiguous |
| `actor_unauthorized` | the caller may not complete this task |
| `document_invalid` | a required document is missing or fails validation |
| `not_in_review` | the task is not in `in_review` |
| `task_blocked` | the task is blocked |
| `executor_missing` | no declared executor (`ha task declare-executor`) |
| `closeout_placeholder` | the closeout is still scaffolding |
| `review_missing` | no approved Review |
| `consent_missing` | no review-consent record |
| `ci_missing` | the contract declares `ci` but no witnessed green run (`settings.ci.workflows`, `ha ci observe pull`) |
| `code_doc_missing` | the contract declares `code-doc-reconciliation` but no verified witness (`ha task code-doc reconcile`) |
| `gate_witness_missing` | a canonical checker witness for another declared gate is missing |
| `decision_lineage_missing` | the load-bearing decision lineage is not closed |
| `lease_held` | a lease is still held |
| `doc_sync_required` | authored documents are pending sync |
| `fact_missing` | no active `produces` fact edge |
| `fact_retirement_undeclared` | a fact retirement was not declared |

For an applicable execution, `ha task code-doc reconcile <task-id>` derives the
unique submitted execution, commit, iteration, and repository paths from its
deliverables, verifies those paths against the Git repository that owns the
commit, and publishes the typed witness. A reviewed report-only submission
completes without inventing a repository path when all of its declared
deliverables are task-package artifacts.

If any blocker stands, the task stays where it is — and because `done` is a
load-bearing write, that write itself goes through the single writer described
in [the write path](02-write-path.md), so the accepted transition leaves a
durable, attributable trace.

There is one operational caveat for anyone developing gates locally: the `ha`
binary runs built CLI output, not TypeScript source. A gate merged into source
is not active for that local binary until `packages/cli/dist` is rebuilt, so
testing a new or changed gate requires rebuilding before invoking
`ha task complete`.

## The three named gates, as mechanism

learn/03 introduced three gates by name. They are not three functions of the
same name; they are intent-level names for three pieces of machinery. Here is
what each maps to in current code.

**Exit Gate.** The completion readiness above: the whole blocker table in front
of `ha task complete` — closed decision lineage (`decision_lineage_missing`),
review and consent in place, a witness for each declared completion gate, and
closeout readiness at `ready`/`passed`. Ledger completeness is not a vibe — it
is the append record of canonical events, covered in
[provenance and events](06-provenance-and-events.md).

**Usability Gate.** Fires against a delivered capability: a fresh agent, given
only the self-describing surface (`--help` and a capabilities listing), must be
able to drive it end to end. The structure under test is the discovery path —
does the command advertise itself, is the entry point findable.

**Disposition Guard.** The disposition matrix in
`packages/kernel/src/domain/entity-kind-registry.ts`: every entity kind
declares which exit actions it supports (`retire`, `supersede`, `invalidate`,
`archive`, `tombstone`, `hard-delete`) and why the rest are unsupported. A
decision's correction is a `supersede` relation rather than deletion; a fact's
exit is `invalidate` — expressed as a superseding append, not physical removal,
because something may depend on it for provenance.

## Why this shape

Every gate here shares one shape: collect issues, and let a non-empty list
block the transition. That is fail-closed expressed as code. The gate does not
decide *what* "done" ought to mean — the layered standard it checks against is
the subject of [the adoption law](../../learn/en/05-adoption-law.md). The
gate's job is narrower and more mechanical: given a standard, make the default
answer "no," and make a transition earn its "yes" by leaving no unresolved
issue behind.
