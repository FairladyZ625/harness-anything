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
active work
    │  ha task review <id>
    ▼
[ fact gate ] ─ reject ─▶ (status unchanged)
    │ pass
    ▼
[ review gate ] ─ reject ─▶ (status unchanged)
    │ pass
in_review
    │  ha task complete <id> --ci passed
    ▼
[ fact gate ] · [ completion gate ] ─ reject ─▶ (status unchanged)
    │ pass
done  (terminal — write goes through the single coordinator)
```

A terminal status like `done` is never a status you can set directly. The
orchestrator refuses a direct write to a terminal status and routes it through
the completion path instead, so the gate stack cannot be bypassed by "just
setting the field."

## The fact-record gate

The most concrete lifecycle gate is also the strictest, and it is worth stating
plainly because it is pure mechanism.

**A task cannot move into review or completion unless its `facts.md` holds at
least one real `F-` fact record.**

Inside the orchestrator, both `reviewTask` and `completeTask` call a fact gate
before anything else. It resolves the task's local `facts.md`, parses the fact
records out of it, and if the file is missing — or present but contains zero
records — the transition fails with a `task_fact_required` error. The remediation
the gate hands back is literal:

```text
Task review and completion require at least one real F- fact record.
Add one with:
  ha fact record --task <id> --statement "<verified result>" \
    --source "<evidence path or command>" --confidence high
```

A fact record is append-only and carries an `F-` id, a `statement`, a `source`,
and a `confidence`. What the gate enforces, structurally, is that a body of work
cannot be declared reviewable while claiming *nothing verifiable*. There has to be
at least one recorded, sourced observation on the ledger before the work is
allowed to advance. Declaration is cheap; a fact with a source is not.

## The review gate

Once a task has at least one fact, the review gate inspects the task's
`review.md`. Review findings live in a Markdown table, and the gate parses that
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
completion gate reads several axes off the task's projected row and requires all
of them to line up:

| Axis | Requirement to pass |
|---|---|
| review gate | must be `passed` |
| CI gate | must be `passed` |
| closeout readiness | must be `ready` or `passed` |

If the review gate isn't passed, if CI isn't passed, or if closeout readiness is
anything weaker than ready, the completion gate returns issues
(`review_not_passed`, `ci_not_passed`, `closeout_not_ready`) and the task stays
where it is. The task is only written to `done` after the gate returns an empty
issue list — and, because `done` is a load-bearing write, that write itself goes
through the single write coordinator described in
[the write path](02-write-path.md), so the accepted transition leaves a durable,
attributable trace.

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
