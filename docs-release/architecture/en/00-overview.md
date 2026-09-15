# The shape of the system

The active canonical generation accepts commands in SQLite. The canonical
database and its required content objects are durable records; Git publication,
the authored worktree, and the read projection all follow that record.

## Storage roles

The resolved local root contains `store/generations/<generation>/ledger.sqlite`
and `store/generations/<generation>/objects/sha256/`. Required object bytes and
directory links are synchronized before the database transaction accepts a
command. One `BEGIN IMMEDIATE` transaction checks the writer epoch fence and
operation identity, and commits the complete event interval and command outcome
atomically. A Git commit is not an acceptance boundary.

`packages/kernel/src/store/sqlite-event-store.ts` implements that transaction.
`packages/kernel/src/store/task-event-store-factory.ts` resolves the active
generation for readers and writers. `sqlite-task-event-store.ts` adapts the
canonical event-store port and publishes accepted events' authored documents
and `events/segments/manifest.json` to Git. Each run publishes only the events
accepted since the cut Git's manifest names, on top of that commit, and the
authored worktree settles the same events. A file with a concurrent edit keeps
the user's bytes and is reported as a conflict; the worktree facet stays
pending until a later event or `ha doc materialize` settles that file.

SQLite uses `journal_mode=WAL` with `synchronous=FULL`; see
`packages/kernel/src/store/sqlite-event-store.ts`.

## Request path

CLI and GUI submit typed commands over the daemon JSON-RPC protocol. The daemon
owns a serialized `RepoCell` per repository; the actual writer runs in a
dedicated `repo-writer-worker` thread supervised by
`packages/daemon/src/writer-supervisor.ts`. The persistent `writer-epoch` fence
(`packages/daemon/src/writer-epoch.ts`) rejects stale writers after a daemon
restart and prevents split-brain writers in fleet scenarios. Application and
domain handlers validate authorization, entity transitions, and the frozen
write plan before acceptance; the read projection catches up from the canonical
SQLite event stream.

A repository runs in one of four modes: `local`, `remote-proxy`,
`remote-center`, or `remote-edge` (`packages/daemon/src/repo-mode.ts`). Edge
nodes forward commands to the center; they do not gain a second writer.

A write receipt reports `status: accepted_durable` only after a committed
outcome is read back by operation id. Its acceptance interval is separate from
projection, Git, worktree, and replica facets. `ha receipt show <op-id> --wait
git_verified` waits for the Git facet; timeout leaves accepted durability
intact. Repository, generation, and revision identify each verified cut. An
unconfigured replica is reported explicitly.

## Recovery and conversion

The projection is disposable; `ledger.sqlite` and its required objects are not.
A Git clone alone cannot recover accepted commands that were never published.
Back up the canonical database with a consistent SQLite copy and its matching
objects produced by `ha backup` (`packages/kernel/src/store/ledger-backup.ts`)
before changing the daemon build.

New repositories run natively on generation 2 and carry a
`generation-activation/v2` certificate. Existing generation-1 repositories
convert offline through a verified backup path: `legacy-generation-conversion.ts`
imports an immutable prefix after writes stop, `generation-two-conversion.ts`
runs activation preflight and conversion, and `resolveActiveGeneration` only
selects generation 2 once the activation certificate is on disk. Conversion is
not an in-place rewrite; historical in-place rewrite commands are retired.

See [the projection](03-projection.md) and [legacy conversion](../../migration-legacy-ledger-recovery.md).
