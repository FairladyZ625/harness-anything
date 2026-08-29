# The shape of the system

[What problem is this solving?](../../learn/en/00-overview.md) makes a bet: the
durable trail an agent leaves — choices, progress, observations — should be
promoted into structured entities that live in git, with Markdown as the source
of truth. This page shows the shape of the machine that holds that bet up: what
the layers are, what each one does, and where the truth actually sits.

## The one line everything rests on

There are three storage roles, and they are not peers.

> Git-backed canonical events and authored Markdown are the published record.
> The local WAL durably holds accepted writes until they are materialized to
> git; SQLite is a rebuildable read projection.

The three knowledge primitives — decision, task, and fact — are authored in
plain Markdown with YAML frontmatter. The execution chain is authored too:
Session, Execution, and Review records preserve who performed one delivery
round, what was submitted, and who judged it. Each accepted mutation is also a
canonical event. During the publication window, `.harness/wal/` can contain
accepted events that are not in git yet; reads merge those events with the
git-backed stream. Nothing about correctness depends on the SQLite database
surviving; it remains a disposable projection (ADR-0027 D1, D5).

Hold onto that asymmetry. It explains why the layers are arranged the way they
are: writes cross the daemon boundary, become durable in the WAL, and are then
published to Markdown and git; reads are served from a projection that can catch
up or rebuild from the merged canonical stream.

## The layers

```text
write path
  packages/cli/ + packages/gui/       thin protocol clients
                 |
                 v local daemon RPC
  packages/daemon/src/                DaemonHost + per-repo RepoCell
                 |
                 v serialized command handling
  packages/application/               orchestration services
  packages/kernel/src/domain/         contracts + frozen write plans
                 |
                 v append, then materialize
  packages/kernel/src/store/          .harness/wal/ -> git ledger

read path
  merged WAL + git canonical stream
                 |
                 v catch up or rebuild
  packages/kernel/src/projection/     SQLite -> CLI / GUI
```

Read the stack top to bottom and each layer has one job.

**Delivery surfaces — `packages/cli/` and `packages/gui/`.** `ha` parses and
renders commands, but it does not compose application or kernel writers. Durable
commands are sent through the daemon protocol. The GUI is another client of that
protocol. These surfaces can request a write; they do not own write state.

**Local daemon and RepoCell — `packages/daemon/src/`.** The daemon host routes a
request to the RepoCell for its canonical repository. That cell resolves
attribution and authorization, holds the active writer generation, and queues
writes so only one operation advances the repository at a time. This is the
coordination point for the single write path.

**Application services and kernel domain.** Services in `packages/application/`
and specialized daemon handlers orchestrate each command family. The contracts,
transitions, schemas, and frozen write plans live under
`packages/kernel/src/domain/` and `packages/kernel/src/schemas/`. Invalid or
unauthorized commands are rejected before an event is appended.

**Canonical event store — `packages/kernel/src/store/`.** The implementation in
`wal-shadow-event-store.ts` appends accepted events and their content blobs to
the local WAL first. `wal-git-materializer.ts` publishes pending revisions to git
in order and advances the canonical and authored refs together. Reads merge WAL
and git during that publication window; recovery retries any pending cut.

**Published ledger and projection.** Git holds the settled canonical events and
authored Markdown that you can clone, diff, and review. The local WAL is durable
handoff state for accepted writes awaiting publication, not a peer copy of the
published ledger. `packages/kernel/src/projection/` builds the SQLite read model
from the canonical stream; the database can be caught up or rebuilt.

**Adapters.** `packages/adapters/` supplies runtime-specific bindings. It does
not create a second write path or source of truth.

## How a request moves

A write and a read share the daemon boundary, then take different storage paths.

A **write** enters through a thin client and crosses the local daemon protocol.
The repository's RepoCell serializes it; application and domain handlers enforce
its lifecycle rules, authorization, and frozen write plan. If accepted, the
canonical event becomes durable in `.harness/wal/`. The Git materializer then
publishes pending events and their authored documents as an ordered commit.
Claim, submit, and review remain coordinated domain commands (ADR-0027 D1-D3,
D5); the CLI never writes those Markdown files or git refs itself.

A **read** also enters through the daemon and is normally served from the SQLite
projection. The projection catches up from the canonical stream, which merges
the published Git cut with any accepted events still pending in the WAL. If the
database is missing, it can be rebuilt from that canonical stream. Either way the
answer comes from durable structured records, never from prose in a transcript.

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
