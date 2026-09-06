# The shape of the system

Generation 1 accepts commands in SQLite. The canonical database and its required
content objects are durable records; Git and the read projection follow that record.

## Storage roles

The resolved local root contains `store/generations/1/ledger.sqlite` and
`store/generations/1/objects/sha256/`. Required object bytes and directory links are
synchronized before the database transaction accepts a command. One
`BEGIN IMMEDIATE` transaction checks the repository writer lease and commits the
complete event interval and command outcome. A Git commit is not an acceptance boundary.

`packages/kernel/src/store/sqlite-event-store.ts` implements that transaction.
`sqlite-task-event-store.ts` adapts the canonical event-store port and publishes
accepted events' authored documents and `events/segments/manifest.json` to Git.
The publisher reads back the manifest and document bodies, modes, and retirements
before certifying the Git cut. Worktree visibility is checked separately and may
remain pending when authored files have concurrent edits.

The old segment WAL, merged shadow reader, publication pointer family, and
materializer worker are retired. SQLite's own transaction journal remains an
implementation detail of the canonical database.

## Request path

```text
CLI / GUI -> daemon RPC -> RepoCell single-writer queue
  -> application and domain validation -> SQLite transaction + required objects
  -> event-derived Git publisher / independently rebuilt read projection
```

The daemon resolves repository identity, authorization, and writer epoch. Domain
handlers prepare events and frozen write plans. Invalid commands do not enter the
accepting transaction. Reads use the projection, which catches up from the canonical
SQLite event stream and object closure.

A write receipt reports `status: accepted_durable` only after a committed outcome
is read back by operation id. Its acceptance interval is separate from projection,
Git, worktree, and replica facets. `ha receipt show <op-id> --wait git_verified`
waits for the Git facet; timeout leaves accepted durability intact. Repository,
generation, and revision identify each verified cut. An unconfigured replica is
reported explicitly.

## Recovery and conversion

The projection is disposable; `ledger.sqlite` and its required objects are not.
A Git clone alone cannot recover accepted commands that were never published.
Back up the canonical database using a consistent SQLite copy and retain its
matching objects before changing the daemon build.

Historical format conversion runs before activation, from an immutable generation-0
snapshot into an inactive generation-1 database. Activation verifies the converted
prefix and required objects. Later opens preserve that prefix while allowing new
accepted events. Historical in-place rewrite commands are retired.

See [the projection](03-projection.md) and [legacy conversion](../../migration-legacy-ledger-recovery.md).
