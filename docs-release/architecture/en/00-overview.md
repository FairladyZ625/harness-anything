# The shape of the system

[What problem is this solving?](../../learn/en/00-overview.md) makes a bet: the
durable trail an agent leaves — choices, progress, observations — should be
promoted into structured entities that live in git, with Markdown as the source
of truth. This page shows the shape of the machine that holds that bet up: what
the layers are, what each one does, and where the truth actually sits.

## The one line everything rests on

There are two stores, and they are not peers.

> Markdown in your git repository is the source of truth. SQLite is a
> rebuildable projection — a fast read cache you can delete and regenerate from
> the Markdown at any time.

Every entity — decision, task, fact — is a plain Markdown file with YAML
frontmatter, committed to git. Nothing about the system's correctness depends on
the database file surviving. Delete it and the next read rebuilds it from the
files on disk. The Markdown is durable and authoritative; the SQLite file is
disposable and fast. When the two disagree, the Markdown wins by definition,
and a freshness check exists precisely to notice the disagreement.

Hold onto that asymmetry. It is the single fact that explains why the layers are
arranged the way they are: writes flow *down* toward Markdown and git; reads are
served *from* a projection that any write can invalidate and any command can
rebuild.

## The layers

```text
  ┌───────────────────────────────────────────────────────────┐
  │  CLI command surface            packages/cli/              │
  │  the `ha` command (TypeScript / Node)                      │
  └───────────────────────────────┬───────────────────────────┘
                                  │
  ┌───────────────────────────────▼───────────────────────────┐
  │  Application / lifecycle        packages/application/      │
  │  orchestration + gates                                     │
  │  task-lifecycle-orchestrator.ts · task-lifecycle-gates.ts  │
  └───────────────────────────────┬───────────────────────────┘
                                  │
  ┌───────────────────────────────▼───────────────────────────┐
  │  Kernel                         packages/kernel/src/       │
  │                                                            │
  │    domain/              entity models & lifecycles         │
  │    schemas/             frontmatter schemas (effect Schema)│
  │    store/               Markdown I/O + write journal       │
  │    write-coordination/  the single write path              │
  │    projection/          SQLite read model                  │
  └───────────────────────────────┬───────────────────────────┘
                                  │
  ┌───────────────────────────────▼───────────────────────────┐
  │  Durable store                  git + plain Markdown files │
  └───────────────────────────────────────────────────────────┘

  Also public: packages/adapters/ (runtime bindings)
               packages/gui/      (a read view over the same data)
```

Read the stack top to bottom and each layer has one job.

**CLI command surface — `packages/cli/`.** This is `ha`, the command an agent or
a human actually types. It parses arguments, resolves which entity and operation
you mean, and hands the request down. It owns no truth of its own; it is a
doorway into the application layer. The commands a fresh agent can discover with
`--help` are the entire public surface — nothing load-bearing happens that isn't
reachable from here.

**Application / lifecycle orchestration + gates — `packages/application/`.** This
layer runs the lifecycles. When a task moves from one state to the next, an
orchestrator (`task-lifecycle-orchestrator.ts`) sequences the steps and a set of
gates (`task-lifecycle-gates.ts`) decide whether the move is allowed. Gates fail
closed: the default answer is *reject*, and a transition proceeds only when its
checks pass. This is where "done means done" is actually enforced, not merely
described.

**Kernel — `packages/kernel/src/`.** The kernel is the part deliberately kept
small. It has five internal neighborhoods:

- `domain/` holds the entity models and their lifecycles — the state machines
  for decisions and tasks, and the fact model that has no lifecycle at all.
- `schemas/` holds the frontmatter schemas, written in effect-Schema. These are
  the contracts every file on disk must satisfy: field names, patterns, and
  integrity rules that reject malformed records before they are ever stored.
- `store/` performs Markdown I/O and owns the write journal — the record of what
  was written and how.
- `write-coordination/` is the single write path. Every load-bearing write funnels
  through here so that one enforcement point stamps, validates, and commits it.
- `projection/` builds and reads the SQLite model — the rebuildable cache the
  read side is served from.

**Durable store — git + plain Markdown.** The bottom of the stack is just files
in a repository. Every accepted write ends as a commit. This is the layer you can
clone, diff, review in a pull request, and hand to another agent cold. It is the
only layer whose loss you cannot recover from — which is exactly why it, and not
the database, is the source of truth.

**Adapters and GUI.** `packages/adapters/` binds the kernel to concrete runtimes;
`packages/gui/` is a read-oriented view over the same projected data. Neither is a
second source of truth — both sit on top of the same Markdown-and-projection core.

## How a request moves

A write and a read travel opposite directions through the same stack.

A **write** enters at the CLI, is shaped by the application layer's lifecycle
rules, passes (or fails) its gates, and — if accepted — goes through the single
write path, which validates it against a schema, stamps it, writes it atomically
to Markdown, and commits it to git. One door in, one enforcement point, one
durable result.

A **read** is served from the projection. If the SQLite cache is fresh, the read
is fast; if it is missing or stale, the projection layer rebuilds it from the
Markdown first. Either way the answer is derived from the files, never from prose
sitting in a transcript.

## Where to go next

Each remaining chapter zooms into one layer of this stack.

- [01 · How the three entities live on disk](01-storage-model.md) — the directory
  layout, frontmatter schemas, and ID patterns for decision, task, and fact.
- [02 · The single write path](02-write-path.md) — the one door every
  load-bearing write goes through, and what it stamps on the way.
- [03 · The projection: Markdown to SQLite](03-projection.md) — how the read cache
  is rebuilt, the real tables it holds, and how staleness is detected.
- [04 · Gates in the pipeline](04-gates-in-the-pipeline.md) — the fail-closed
  checks that guard lifecycle transitions.
- [05 · Verticals: the declaration engine](05-vertical-engine.md) — how a
  declarative `vertical.json` adds domain concepts without touching the kernel.
- [06 · Provenance, verdicts, and the event ledger](06-provenance-and-events.md) —
  how every entity is bound to what produced it, and how "what happened" is
  recorded.
