# Provenance, verdicts, and the event ledger

[Decision vs. verdict](../../learn/en/02-decision-and-verdict.md) draws a hard
line: a decision answers *which path do we take?* and a verdict answers *does
this one output hold?* — and conflating them lets one quietly eat the other. This
page shows the machinery that keeps them apart, plus the two record structures
they lean on: the `provenance[]` binding that ties every entity to what produced
it, and the append-only event ledger that the Exit Gate reads for completeness.

## Provenance: every entity names its origin

Every entity on disk carries a `provenance[]` array, and it is required to have
**at least one entry**. Provenance is what binds a record to the run that
produced it, so that no entity floats free of an origin.

A single provenance entry is small and strict. Its schema
(`ProvenanceEntrySchema` in `packages/kernel/src/schemas/common.ts`) is exactly
three fields, all non-blank:

| Field | Meaning |
|---|---|
| `runtime` | which agent runtime produced it — one of `human`, `claude-code`, `codex`, `zcode`, `antigravity` |
| `sessionId` | the session that did the writing |
| `boundAt` | the timestamp the binding was stamped |

Because the field is an *array*, an entity can accumulate more than one binding as
it passes through more than one run — but it can never have zero. An entity with
an empty origin would be a record you cannot trace, and the schema does not allow
one.

## The backfill path

Provenance is required, but records predating the requirement, or imported from
elsewhere, may arrive without it. There is a dedicated path that fills the gap:
`packages/cli/src/commands/core/provenance-backfill.ts`, run as
`ha migrate-provenance`.

It works in two modes. In `dry-run` it only reports; in `apply` it writes. The
scan walks every task `INDEX.md`, skips anything that isn't a task package (wrong
schema, or no frontmatter at all), and for each real task package checks whether
`provenance:` already carries an entry. If it does, the task is counted as
*already present* and left untouched. If it doesn't, a synthetic entry is
built — stamped with the current session's runtime, a generated backfill session
id, and a `boundAt` timestamp — validated against `ProvenanceEntrySchema`, and
patched into the frontmatter.

Two properties matter here. First, backfill is **idempotent**: a task that
already has a provenance entry is never doubled up. Second, the applied writes do
not touch disk directly — they go through the write coordinator (see
[the write path](02-write-path.md)), so even a bulk migration produces the same
attributable, atomic writes as any other load-bearing change.

```text
scan every task INDEX.md
    │
    ├─ not a task package ──────────▶ skipped
    ├─ provenance[] already present ─▶ already present (untouched)
    └─ provenance[] missing
           │  build synthetic entry {runtime, sessionId, boundAt}
           │  validate against ProvenanceEntrySchema
           ▼
        dry-run: report only   │   apply: patch via write coordinator
```

## Verdict: a judgment, not a decision entity

A **verdict** is a PASS/FAIL judgment on one concrete output, produced when a task
goes through review or completion. The machinery for it is the review gate and
the completion gate described in
[gates in the pipeline](04-gates-in-the-pipeline.md): the review gate emits a
passed contract or a set of blocking findings; the completion gate lines up
review, CI, and closeout and returns pass or a list of issues.

The structural fact worth underlining is what a verdict is *not*. A verdict is
**not** a decision entity. It does not get a `dec_`-style id, it does not enter
the centralized decisions directory, and it does not go on the decision queue.
Where does it live instead? On the task's own ledger — the review contract, the
closeout, and the fact records the task accumulates. A verdict is recorded next to
the work it judged, not promoted into the standing choices that shape future work.

| | Decision | Verdict |
|---|---|---|
| Question | which path? (WHY) | does this output hold? (PASS/FAIL) |
| Where recorded | a decision entity in `decisions/` | the task's review/closeout/fact ledger |
| On the decision queue? | yes | no |
| Reversible | a later decision can supersede it | one-shot, fails closed |

## Routing is not automatic

If a verdict is not a decision, when does a decision ever come out of one? Only
when the verdict surfaces something *strategic* — "this batch of results says we
chose the wrong path." And even then, the routing is **not automatic**. Nothing
in the pipeline turns a FAIL into a new decision on its own. A routine failing
verdict closes findings and blocks a transition; it does not open a decision. A
strategically significant verdict *prompts* a human to propose a new decision, as
a deliberate act.

This is the mechanical reason the decision queue stays meaningful. If every
PASS/FAIL auto-created a decision, the queue would fill with per-output
bookkeeping until no one could watch it. By keeping verdicts on the task ledger
and requiring a deliberate step to escalate, the flood of routine verdicts never
reaches the one queue a human is meant to see.

## The runtime event ledger

The runtime event ledger is an **append record of what happened** during a run:
sessions starting, turns, steps, tool calls, approvals, interrupts, results,
costs. It is the raw log of activity, kept per session, and it is one of the
structures the Exit Gate reads when it checks whether a body of work is genuinely
complete.

Each event conforms to `RuntimeEventRecordSchema`
(`packages/kernel/src/schemas/runtime-event.ts`, schema tag `runtime-event/v1`).
An event has a stable `evt_`-prefixed id, a `recordedAt` timestamp, and a `kind`
drawn from a fixed set:

```text
session · turn · step · tool · approval · interrupt · result · cost
```

Every event names its `session` (with the runtime, and optionally the `taskId`,
`decisionId`, or `factRef` it touched), and then carries exactly one populated
detail block matching its kind — a `tool` block names the tool and any error
code; an `approval` block records `approved` / `rejected` / `timeout`; a
`result` block records `started` / `succeeded` / `failed` / `cancelled`; a `cost`
block records tokens and wall time. The CLI surface
(`packages/cli/src/commands/core/runtime-event.ts`) offers exactly two
operations: **append** a new event, and **list** a session's events. There is no
edit and no delete — the ledger only grows.

## How the pieces connect

Three separate structures, one spine of accountability:

```text
provenance[]        ──▶  every entity names the run that produced it
event ledger        ──▶  every run leaves an append-only trace of what it did
verdict on ledger   ──▶  every judged output is recorded next to the work

Exit Gate reads the event ledger for completeness (see 04-gates-in-the-pipeline)
A strategic verdict → a human proposes a new decision (see learn/02)
```

Provenance answers *who produced this record*. The event ledger answers *what
happened, in order*. A verdict answers *did this one output hold*. None of the
three is a decision, and none of them silently becomes one — the escalation from
a verdict to a decision is always a deliberate human act, which is exactly what
keeps the decision spine, and the queue that watches it, worth reading. The
"why" behind that separation is the argument in
[decision vs. verdict](../../learn/en/02-decision-and-verdict.md); the
"done" it feeds into is [the adoption law](../../learn/en/05-adoption-law.md).
