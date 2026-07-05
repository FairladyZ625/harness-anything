# Harness Anything

> Turn the **decisions, tasks, and facts** your AI agents produce into first-class structure on git — auditable, reversible, and reusable — instead of leaving them buried in chat logs that vanish the moment the work is done.

When an agent finishes a task, where does the *reasoning* go? Why it chose approach A over B, what it tried, what it learned — normally that lives in a transcript nobody reads again. Harness Anything captures it as durable records you can query, challenge, and build on.

Three primitives, all versioned in your repo:

- **decision** — the WHY. A choice, its alternatives, and its evidence. Reversible.
- **task** — the WHAT. A unit of work moving through a six-state lifecycle.
- **fact** — the IS. An append-only observation, anchored to the task that produced it.

The `ha` CLI is the tool you use today. It writes plain Markdown into your git repo and keeps a rebuildable SQLite projection for fast queries.

---

## Get running fast

Install it, run one real loop, watch the structure grow, and see what it does for yourself — about 10 minutes.

→ **[start/](start/en/00-what-is-this.md)**

## Understand why it's built this way

The design is deliberate, and every choice has a reason. This path walks through the primitive kernel, the decision and adjudication mechanics, the gates, the extension model, and the methodology.

→ **[learn/](learn/en/00-overview.md)**

## See how it's actually built

Finished `learn/` and wondering *how the system delivers on those claims*? This path is the mechanism: the layered architecture, how the three entities live on disk, the single write path, the rebuildable SQLite projection, the gates, and the vertical engine.

→ **[architecture/](architecture/en/00-overview.md)**
