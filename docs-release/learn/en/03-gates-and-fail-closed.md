# Gates and fail-closed

A record is only as trustworthy as the moment it's written. If any write can slip
into the repository unchecked, the whole structure — decisions, tasks, facts —
degrades into a wall of prose again, just with more ceremony. So the core rule is
simple and strict:

**Every load-bearing write passes through a gate, and the gate is closed by
default.**

*Fail-closed* means exactly what it says. If the evidence is insufficient or a
check doesn't pass, the write is **rejected**, not waved through. The safe
default is "no." You have to earn the "yes." An open-by-default system trusts that
nothing went wrong; a fail-closed system assumes something might have, and makes
you prove otherwise before the record changes.

To make that enforceable, load-bearing writes don't go straight to disk. They go
through a single **write coordinator** — one chokepoint that stamps a watermark
and commits to git automatically. One door means there's exactly one place to
enforce the rule, and every accepted write leaves a durable, attributable trace.

## Three gates

Different kinds of write are load-bearing in different ways, so there are three
gates, each guarding a different failure.

| Gate | Guards against | Fires when |
|---|---|---|
| **Exit Gate** | a milestone that isn't actually finished | all its decisions are settled **and** the task chain is closed **and** the event ledger is complete |
| **Usability Gate** | a capability that exists but can't be used | a fresh agent, armed only with `--help` and a capabilities listing, can't actually run it end to end |
| **Disposition Guard** | unsafe deletion | something with inbound edges is up for removal — a referenced decision is never physically deleted; a fact is never deleted on its own |

**The Exit Gate** asks whether a body of work is genuinely done, not whether
someone declared it done. Declaration is cheap; the gate checks the structure.
Are the load-bearing decisions all resolved? Does the chain of tasks actually
close, with nothing left blocked or dangling? Is the ledger of what happened
complete? Only then does the milestone pass.

**The Disposition Guard** keeps deletion from quietly severing the graph.
Anything with inbound references is protected: a decision that other entities
still point to is never physically deleted — at most it's retired, so its history
and its edges survive. A fact is never deleted in isolation, because something may
depend on it for provenance. You can archive; you generally can't destroy.

## Why usability needs a gate too

The Usability Gate is the least obvious of the three, and it earns its place by a
hard lesson: **a capability existing is not the same as an agent being able to
use it.** A feature can be fully implemented, fully tested, and completely
unreachable in practice — because nothing tells the agent it's there, or the
entry point is a maze, or the one command that would invoke it isn't discoverable
from `--help`.

A capability an agent can't find is, for all practical purposes, not built. So
the gate makes the test explicit: a *fresh* agent, with no memory of how the
thing was made, given only the self-describing surface (`--help`, a capabilities
listing), must be able to drive it to a working result. If it can't, the work
isn't done — no matter how green the unit tests are. This is the mechanical
enforcement of "search, not memory": the capability has to advertise itself, not
rely on someone remembering it exists.

## Gates are the mechanism, not the standard

A gate is a piece of machinery — it fires, it checks, it passes or rejects. It
doesn't decide *what* "done" should mean; it enforces a standard defined
elsewhere. That standard — the layered definition of done that the Exit Gate and
its siblings actually check against — is its own topic:
[05 · The adoption law](05-adoption-law.md).
