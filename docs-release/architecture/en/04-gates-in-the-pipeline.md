# Gates in the pipeline

[Gates and fail-closed](../../learn/en/03-gates-and-fail-closed.md) makes a
promise: no load-bearing write slips in unchecked, and the safe default is "no."
This page shows the machinery that keeps that promise — where gates sit in a
task's life, what structure each one inspects, and why an insufficiently backed
transition is rejected rather than waved through.

## Where gates live

A gate is not a policy document; it is a function that runs on a **lifecycle
transition** and returns pass or reject. Tasks are the entities that move through
a lifecycle — a status field on the task package advances from active work into
review and finally into a terminal `done`. The gate code sits in the application
layer (`packages/application/src/task-lifecycle-gates.ts`) and is driven by an
orchestrator (`packages/application/src/task-lifecycle-orchestrator.ts`); the CLI
surface that invokes them is `packages/cli/src/commands/core/task-gates.ts`.

The important property is *fail-closed by construction*. Each gate function
collects **issues**. If the issue list is non-empty, the transition does not
happen — the orchestrator returns a failure result carrying those issues, and the
task's status is never written. Nothing is "assumed fine." A transition earns its
way through by producing an empty issue list.

```text
active Execution
    │  ha task transition <id> in_review --completion-claim "..."
    ▼
[ submit: seal bindings + six-field packet ] ─ reject ─▶ (status unchanged)
    │ submitted
in_review
    │  ha task review-execution <id> ... --rationale "..."
    │  ha task complete <id> [--ci passed]
    ▼
[ approved Review · declared completionGates · closeout ] ─ reject ─▶ (status unchanged)
    │ pass
done  (terminal — write goes through the single coordinator)
```

A terminal status like `done` is never a status you can set directly. The
orchestrator refuses a direct write to a terminal status and routes it through
the completion path instead, so the gate stack cannot be bypassed by "just
setting the field."

## Fact promotion is not a completion gate

Under `dec_mrg3z1we/CH4`, a task may have `0..N` Facts. A Fact is an explicit,
append-only promotion of a load-bearing observation; submit, review, and complete
do not synthesize one. Evidence for a delivery belongs to Execution outputs and
the Submission packet rather than being copied into Facts to satisfy a count.

Consequently, a missing `facts.md`, an empty file, or a file with zero parsed
`F-` records does not block review or completion. Fact recording remains
available when an observation is worth promoting for later decisions or
cross-task reasoning; it is not a universal task-completion quantity gate.

## Submission and Evidence checks

Submitting an active Execution requires a non-empty completion claim and five
array fields that may be empty: deliverables, Evidence refs, verification notes,
known gaps, and residual risks. This is a traceable inspection anchor, not a
proof-shaped file requirement; a text-only claim with zero Evidence is valid
(dec_mrg3z1we/CH1; ADR-0027 D3).

For each `OutputEvidence`, the machine checks only four classes of facts: the
locator exists or is well-formed, the Evidence belongs to this Execution, an
optional SHA-256 matches, and an optional checker receipt exists and is bound to
the same target. It does not decide relevance, correctness, or sufficiency.
Those belong to the Reviewer, who records inspected Evidence IDs and a rationale
in `review/v2` (dec_mrg3z1we/CH2-CH4; ADR-0027 D5-D6).

## The review gate

For a legacy task, the review gate inspects the task's `review.md`. Review
findings live in a Markdown table, and the gate parses that
table into structured findings, each with a severity (`P0`–`P3`), an `open`
flag, and a `blocksRelease` flag.

The rule is narrow and mechanical: if any finding is **both open and
release-blocking**, the review fails, and every such finding is reported back as
a `release_blocking_finding` issue. Only when no open blocking finding remains
does the gate emit a passed review contract (`verifier-backed-review/v1`)
summarizing how many findings were seen and confirming zero open blockers. A
malformed findings table — wrong column count, an invalid severity — is itself a
rejection, not a silent skip; the gate will not read past a table it cannot
validate.

There is a companion check for placeholders. A `review.md` still carrying its
initial "not-started" template, or a `closeout.md` still matching a known
template fingerprint, is treated as *not done*. The gate refuses to accept
scaffolding dressed up as a result.

## The completion gate

Completing a task is the strictest transition, because `done` is terminal. The
`ha task complete` path resolves the selected preset/profile's
`completionGates`, applies only those deterministic gates, enforces the relevant
review path and closeout readiness, and only then writes `done`. Legacy tasks
re-run the `review.md` gate; Execution-bearing tasks require an approved Review
for the current Execution (ADR-0027 D5, D7).

| Check | Requirement to pass | Failure code or issue reported |
|---|---|
| legacy review document | for a task without Execution documents, `review.md` must exist, its findings table must parse, and no open finding may block release | completion reports `review_not_passed`; the underlying review failure may be `review_document_missing`, `review_schema_invalid`, or `release_blocking_findings` |
| Execution Review | an Execution-bearing task must have an approved Review for its current Execution | the Execution completion service reports the missing or non-approved Review |
| review placeholder | the initial `review.md` placeholder must be replaced | `review_placeholder` |
| closeout placeholder | when a placeholder policy is configured, `closeout.md` must not match a known template fingerprint | `closeout_placeholder` |
| code-doc reconciliation | when the resolved contract declares `code-doc-reconciliation`, the task package must contain a hand-written `code-doc-anchors.json` with valid load-bearing records and at least one hard commit or path anchor per record | `code_doc_reconciliation_failed` with issues such as `code_doc_anchors_missing` |
| review gate axis | the completion function receives review as `passed` after the review gate above succeeds | `review_not_passed` |
| CI gate axis | when the resolved contract declares `ci`, the CLI-provided CI gate must be `passed`; otherwise `--ci` is not required | `missing_ci_gate` or `ci_not_passed` |
| closeout readiness axis | projected closeout readiness must be `ready` or `passed` | `closeout_not_ready` |
| task tree dirty check | after the transition sweep, `tasks/<id>/` must be clean enough for the lifecycle writer to commit | `task_tree_dirty` |

When the resolved contract declares this gate, the code-doc reconciliation file
is not generated by `ha task create`; it must be authored into the task package
as `harness/tasks/<id>/code-doc-anchors.json` (ADR-0027 D7).
The document schema is `code-doc-reconciliation/v1`, and each record names a task
package `ledgerPath`, a load-bearing `kind` (`closeout`, `evidence`,
`decision-claim`, or `review`), and anchors. Commit and path anchors are verified
against local git; PR anchors are warning-only unless they also carry a SHA. A
record with no hard commit or path anchor fails even if it names a PR.

If any check fails, the task stays where it is. The task is only written to
`done` after the completion path returns an empty issue list — and, because
`done` is a load-bearing write, that write itself goes through the single write
coordinator described in
[the write path](02-write-path.md), so the accepted transition leaves a durable,
attributable trace.

There is one operational caveat for anyone developing gates locally: the `ha`
binary runs built CLI output, not TypeScript source. A gate merged into source is
not active for that local binary until `packages/cli/dist` is rebuilt, so testing
a new or changed gate requires rebuilding before invoking `ha task complete`.

## The three named gates, as mechanism

learn/03 introduced three gates by name. Here is what each one is checking for,
described at the level of structure rather than intent.

**Exit Gate.** Fires when a whole body of work is put up as finished. It does not
trust the declaration; it checks the structure behind it. Concretely, three
things must hold at once: the load-bearing decisions are all settled (none left
open), the chain of tasks actually closes (nothing blocked or dangling), and the
event ledger of what happened is complete. The completeness of that ledger is not
a vibe — it is the append record of runtime events, covered in
[provenance and events](06-provenance-and-events.md). Any one of the three
missing is a rejection.

**Usability Gate.** Fires against a delivered capability. It checks a
reachability property: a fresh agent, given only the self-describing surface
(`--help` and a capabilities listing) and no memory of how the thing was built,
must be able to drive it end to end. The structure under test is the discovery
path — does the command advertise itself, is the entry point findable — not the
implementation. A capability that works but cannot be found from `--help` fails
this gate, because a capability an agent can't reach is, mechanically, not
adopted.

**Disposition Guard.** Fires on deletion. It inspects the graph for **inbound
edges**. Anything still referenced is protected: a decision other entities point
to is never physically deleted — at most it is retired, so its id and edges
survive; a fact is never deleted in isolation, because something may depend on it
for provenance. The guard's check is a graph question — "does anything still
point at this?" — and if the answer is yes, destruction is refused and archival
is offered instead.

## Why this shape

Every gate here shares one shape: collect issues, and let a non-empty list block
the transition. That is fail-closed expressed as code. The gate does not decide
*what* "done" ought to mean — the layered standard it checks against is the
subject of [the adoption law](../../learn/en/05-adoption-law.md). The gate's job
is narrower and more mechanical: given a standard, make the default answer "no,"
and make a transition earn its "yes" by leaving no unresolved issue behind.
