# Decision vs. verdict

Two words that sound like synonyms but name completely different things — and
conflating them is the single most expensive mistake in this system. Both feel
like an "authoritative ruling," so it's tempting to run them through the same
machinery. Do that, and one of them quietly eats the other.

## Two different questions

A **decision** answers *which path do we take?* — a WHY. A **verdict** answers
*does this submitted Execution hold?* — `approved`, `changes_requested`, or
`dismissed`, with inspected Evidence IDs and a rationale (ADR-0027 D5-D6).

| | Decision | Verdict |
|---|---|---|
| Answers | Which path do we take? (WHY) | Does this submitted Execution hold? |
| Nature | a load-bearing choice | a one-shot judgment on a concrete output |
| Relationship | the *cause* (a standing choice) | the *effect* (a check on one result) |
| Reversible? | yes — a later decision can **supersede** it | no — it's a single ruling, and it fails closed |
| Where it lives | a decision entity in `decisions/` | immutable `review/v2` for one Execution |

A decision is a cause: a standing commitment that shapes future work. A verdict
is an effect: a judgment on one specific delivery round. A decision can be
reversed by proposing a new one; a verdict is an immutable Review round
(ADR-0027 D5).

Why does keeping them apart matter so much? Because if every routine PASS/FAIL is
funneled through the decision machinery, the decision queue — the one thing a
human is meant to watch — fills up with per-output bookkeeping until no one can
see it, and people start rubber-stamping to get through the pile. The routine
verdicts are the flood; keeping them out of the decision queue is what keeps the
decision queue meaningful. Only when a verdict surfaces something strategic
("this batch of results suggests we chose the wrong path") does it *trigger* a
new decision. That trigger — not every review — is the real moment a decision's
evidence gets consumed.

## The decision command family

Think in workflow, not API. A decision moves through a small, closed set of
operations:

```text
                 ┌──▶ reject
propose ──▶ accept / reject / defer
   │             └──▶ defer
   │
   └──▶ (once active) supersede · amend · retire
```

- **propose** — draft the choice. Proposing *must* create evidence edges linking
  the decision's claims to the tasks and facts that support them.
- **accept / reject / defer** — the ruling on the proposal (this is the gate).
- **supersede** — a new decision overturns an old one; the old one is retired,
  never deleted, so the history survives.
- **amend** — revise the reasoning without changing the conclusion.
- **retire** — a decision whose premise no longer holds goes offline.
- **relate** — build a typed edge between a decision and a task or fact; this is
  how evidence is attached.

## Evidence is edges, not embedded arrays

A load-bearing decision goes into the centralized `decisions/` directory, and its
evidence is recorded as **typed relations** — real edges in the graph — not as an
array stuffed into the document's frontmatter. This is deliberate:
relation-based coverage means "is this claim reachable from a living fact?" is a
graph query, not a count of entries in a list.

That does **not** make acceptance a coverage gate. Accept is a judgment gate: a
decision can go active once it has at least one evidence relation from a claim
to a real graph entity, or an explicit judgment-only rationale. Full per-claim
coverage is enforced later at reckoning and milestone exit, where facts now
exist. There the checker fails closed for any uncovered load-bearing claim.

## The ADR is a projection, not a parallel ledger

An Architecture Decision Record and a decision entity look almost identical —
both record a reasoned choice with context and consequences. But they sit at
different layers, and getting the relationship wrong creates a slow, expensive
drift.

The rule: **the decision entity is the single structured source of truth. The ADR
is a human-readable projection of it — evidence hung on the decision, or a
rendered view — never a second, independently-evolving account.**

```text
decision entity  ──renders──▶  ADR
  (source of truth,             (readable narrative,
   holds ID, graph edges,        text-mentions the ID,
   lifecycle state)              inert — never writes back)
```

Why forbid the ADR from becoming a second ledger? Because the same real choice
written in two authoritative places will diverge — and then nobody can say which
one is true. The decision entity holds the ID, the edges, and the lifecycle
state; the ADR may *mention* the decision's ID in prose, but it never writes back
into the graph. When both describe the same choice, the decision is authoritative
and the ADR follows — updated or marked superseded, never left to drift on its
own.

## Search, not memory

There's a reason all of this is structured, centralized, and referenceable rather
than kept in an agent's working memory: a decision has to be *retrievable* to be
reusable. A choice you can't find is a choice you'll make again — probably
differently. Putting decisions in a searchable spine, instead of hoping an agent
recalls them, is what lets the next agent stand on the last one's reasoning. That
principle — search, not memory — is the thread that runs into the adoption law:
[05 · The adoption law](05-adoption-law.md).
