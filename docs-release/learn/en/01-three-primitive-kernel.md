# The three-primitive kernel

A kernel is the part you refuse to grow. Operating systems have one; so do
well-designed type systems. The idea is that a small, orthogonal core can express
everything above it, and that keeping the core small is what keeps the whole
system reasonable over time.

This system's kernel is three primitives — and nothing else is a peer of them.
Everything larger (milestones, standards, reports, roadmaps) is a *combination*
of these three, not a fourth primitive. If you can't build it out of decision,
task, and fact, the instinct is not to add a primitive; it's to ask why not.

## The three primitives

Each primitive answers a different question, in a different tense, and lives in a
different place.

| Primitive | Answers | Tense | Form | Lifecycle | Storage |
|---|---|---|---|---|---|
| **Decision** | WHY / *ought* | choosing (timeless) | an overturnable, load-bearing choice | `proposed → accepted → active → retired / rejected / deferred` | centralized, in a top-level `decisions/` directory |
| **Task** | WHAT / *how far* | in-progress (now) | a state-machine work unit | 6 states + 9 ops | inside its own task container |
| **Fact** | IS / *already so* | completed (past) | an immutable, append-only observation | no lifecycle — only `record` / `invalidate` | embedded in the task package that produced it |

Read the table by column and the design starts to speak. A **decision** is a
*why* frozen into a commitment you can later reverse. A **task** is a *what* in
motion, with real states — planned, active, blocked, in-review, done, cancelled —
and operations to move between them. A **fact** is an *is*: born immutable, it
never changes. If the world changes, you don't edit the old fact; you record a
new one and, if needed, invalidate the old.

An important asymmetry hides in that last row. A fact is *not* a lifecycle
machine sitting beside the other two. It has exactly one authoring action —
`record` — and then it's frozen. Decision and task are the two state machines;
fact is the immutable *substrate* they operate over.

## The closed loop

The three don't just coexist; they feed each other in a cycle:

```text
   decision ──derives──▶ task ──executes──▶ fact
       ▲                                      │
       └──────────────  referenced by  ───────┘
```

- A **decision** ("we should do X") derives a **task**.
- The **task**, when executed, produces **facts** — observations with provenance.
- Those **facts** are referenced back by decisions, as the evidence a choice
  stands on.

Remove any one and the loop can't close. Without decisions, facts are produced
and never consumed — the pond turns green. Without tasks, decisions can't turn
into work. Without facts, decisions have no evidence and can't be honestly
reviewed. The three interlock; only together are they self-consistent.

## Asymmetric storage: task ownership is an edge

Here's the part that's easy to get wrong. Three primitives does **not** mean
three symmetric top-level folders.

- **Decisions are centralized.** They're the spine — the one projection a human
  is meant to watch. So they live together, in `decisions/`.
- **Tasks are containers.** Each task is a package with its own working
  documents.
- **Facts are independent records.** Each one lives at `facts/F-<id>.md` and is
  identified by `fact/F-<id>`. When a task produces it, an active
  `task/<id> -> fact/F-<id>` `produces` edge carries that ownership.

Independence does not discard provenance. A fact still records its observation
source and provenance, while the optional `produces` edge says which task owns it
for completion and navigation. A standalone fact is valid and can later be
related to decisions without inventing a task owner.

Facts gain cross-task significance by **being referenced**. A decision can point
to any canonical fact reference, whether or not that fact has a task owner.

The invariant is **"identity is independent; ownership is a relation."** The
decision stays in `decisions/`, facts stay in `facts/`, and the graph carries
cross-entity context.

Three primitives have clear storage sites, with the relation graph as their
reference bus. Two properties fall out for free:

- **Auditability** — a fact stays welded to the exact circumstances that make it
  meaningful, so its provenance can never drift.
- **Low coupling** — nothing has to be physically gathered to become relevant.
  Relevance is expressed as edges in a graph, not as folder membership, so the
  storage layout stays stable no matter how the web of relationships grows.

## Where the edges go

If the primitives are the organs, the typed relations between them are the
circulatory system. Coverage, review, and cleanup are all graph traversals over
those edges: *can each load-bearing claim of a decision reach at least one living
fact that supports it?* That's a reachability question, answered over a rebuildable
projection of the Markdown — never by scanning prose.

That distinction — **choosing a path** versus **judging whether an output holds**
— is subtle enough to deserve its own chapter. It's the difference between a
*decision* and a *verdict*, and it's next:
[02 · Decision vs. verdict](02-decision-and-verdict.md).
