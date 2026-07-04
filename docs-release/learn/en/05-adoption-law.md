# The Adoption Law and the Four Layers of Done

Most of what teams build is not really adopted. It ships, it passes its tests,
someone demos it — and then the old way quietly wins, because the old way was
never taken off the table. This page is about the one rule that explains that
pattern, and the definition of *done* we derived from it. Of everything in these
docs, this is the part most worth taking with you.

## The adoption law

> **A capability is adopted if and only if it is the sole legal path on a
> load-bearing route. If a legacy alternative still exists and migration is not
> forced, the legacy wins by inertia.**

That is the whole law, and it is unforgiving. Building the better tool is not
enough. Making it available is not enough. As long as the old path remains
walkable, people walk it — not out of stubbornness, but because inertia is the
default and switching has a cost. A feature becomes real only when it is the
*only* way through, or when the way it replaces has actually been removed.

## Four layers of done

If adoption requires being the sole path, then shipping code cannot be the
finish line. So *done* is defined in four ascending layers, each of which must
hold:

1. **Structural justice.** Tests and CI are green; no hard-gate violations. This
   is table stakes — it proves the code runs, not that it matters.
2. **Semantic acceptance.** The implementation actually matches the decision it
   claims to implement — not a plausible neighbor of it, the thing itself.
3. **Adversarial verification.** Load-bearing pieces survive a double-blind red
   team. If it is important, someone tries to break it without knowing how it
   was built.
4. **Usage proof.** After delivery, real usage appears — or the thing is itself
   a forced path with no legacy alternative left standing.

The fourth layer is where the adoption law bites. Something that clears the
first three but fails the fourth is **shipped-unused**: it exists, it works, and
nobody reaches for it. Shipped-unused does not count as a completed milestone.
When a delivery is necessarily a skeleton — infrastructure that cannot yet have
users — that is allowed, but only if its wiring is scheduled at the same moment,
so it has a committed route to the fourth layer rather than an open-ended
someday.

## The reinforcement signal

There is a quiet corollary that turns out to be the most useful heuristic of
all. **The structures we unconsciously reach for by hand, over and over, are the
innovations already validated by behavior.** When you notice yourself manually
doing the same thing repeatedly, that habit is a finished experiment reporting a
result — and the response is to fold it into the system immediately. Sustained,
genuine, manual use *is* the strongest usage proof there is; nothing you could
assert about a feature outweighs the fact that people keep using it without being
told to.

## Why this outlives one project

None of this is specific to any one tool. The adoption law is a general property
of how humans and organizations relate to change: a better option that leaves
the worse option available loses to inertia, every time, until the worse option
is removed. Whatever you are building — a platform, a workflow, a standard, an
internal library — the same test applies. If it is not the sole legal path on a
route people actually take, do not call it adopted, however green the tests are.
That is the one idea to carry out of these pages and into whatever you build
next.

---

See how *done* connects to the machinery that enforces it in
[Gates and Fail-Closed](03-gates-and-fail-closed.md).
