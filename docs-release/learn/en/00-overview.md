# What problem is this solving?

AI agents are astonishingly good at *doing work* and astonishingly bad at
*remembering why they did it*. Give an agent a real task and it will generate,
in a single session, a dense trail of reasoning: why it chose this approach over
that one, how far it got, what it observed along the way. Then the session ends,
and almost all of that trail evaporates.

## The entropy problem

Every session produces three kinds of durable content, whether or not anyone
captures it:

- **Choices** — "we're going with Postgres, not SQLite, because…"
- **Progress** — "the migration is half done; the index rebuild is blocked."
- **Observations** — "at 10k QPS the p99 latency was 50ms."

By default these live in the chat transcript. That means: once the conversation
scrolls away, the *why* is gone, the *state* is gone, and the *evidence* is gone.
The next agent — or the next you, a week later — starts cold. Decisions get
silently re-litigated. Work gets redone. Nothing is auditable, because there is
no artifact to audit; there's only a wall of dialogue that no human will ever
replay in order.

This is entropy: information produced but never consumed, accumulating until it's
indistinguishable from noise. The more an agent "remembers" in prose, the worse
it gets — a pond that only takes inflow eventually turns green.

## The bet: make these first-class, in git

Our bet is that the fix is not better note-taking. It's promoting that trail into
**structured entities that live in git** — Markdown as the source of truth, the
repository as the single place the truth lives.

Not a scratchpad. Entities with lifecycles, state machines, and typed relations
between them. A choice becomes a **decision** that can be proposed, accepted, and
later overturned — with a paper trail. Progress becomes a **task** that moves
through defined states. An observation becomes a **fact** that is immutable and
carries its own provenance. Because they're plain files under version control,
they are diffable, reviewable, and permanent, and any agent can pick them up
without a warm conversation to inherit.

## Three claims

This overview makes three claims; each has its own chapter.

1. **The kernel is only three primitives** — decision, task, and fact. Everything
   else is a combination of these. → see
   [01 · The three-primitive kernel](01-three-primitive-kernel.md)

2. **Every load-bearing write passes through a gate, and gates fail closed.**
   Insufficient evidence or a failed check means the write is *rejected*, not
   waved through. → see
   [03 · Gates and fail-closed](03-gates-and-fail-closed.md)

3. **A capability only gets adopted once it's the single legal path.** If there's
   a way around it, agents will take the way around it — so the mechanism has to
   *be* the road, not a sign beside it (the adoption law). → see
   [05 · The adoption law](05-adoption-law.md)

## Who should keep reading

If you build with AI agents and you've felt the pain of work that can't remember
itself — decisions that vanish, "done" that isn't, context that won't survive a
handoff — the rest of this series is for you.

- [01 · The three-primitive kernel](01-three-primitive-kernel.md) — the three
  entities and how they interlock into a closed loop.
- [02 · Decision vs. verdict](02-decision-and-verdict.md) — two ideas that are
  constantly confused, and why keeping them apart matters.
- [03 · Gates and fail-closed](03-gates-and-fail-closed.md) — the mechanism that
  keeps the record honest.
- [05 · The adoption law](05-adoption-law.md) — why "it exists" is not the same
  as "it's used," and the delivery standard that follows.
