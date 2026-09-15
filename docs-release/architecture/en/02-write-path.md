# The single write path

CLI and GUI submit typed commands over the daemon JSON-RPC protocol. The daemon
owns a serialized `RepoCell` per repository
(`packages/daemon/src/repo-cell.ts`); the actual writer runs in a dedicated
`packages/daemon/src/repo-writer-worker.ts` thread supervised by
`packages/daemon/src/writer-supervisor.ts`. The persistent `writer-epoch` fence
(`packages/daemon/src/writer-epoch.ts`) rejects stale writers after a daemon
restart and keeps exactly one writer at any moment in a fleet; `remote-edge`
nodes forward commands to `remote-center` and do not gain a second writer.
Application and domain handlers validate authorization, entity transitions, and
the frozen write plan before acceptance.

## SQLite accepts the command

`packages/kernel/src/store/task-event-store-factory.ts` selects the active
canonical generation for both readers and writers. Its local storage consists
of `store/generations/<generation>/ledger.sqlite` and matching
`objects/sha256/`.

`packages/kernel/src/store/sqlite-event-store.ts` synchronizes required content
objects before entering `BEGIN IMMEDIATE`. The transaction checks the writer
fence and operation identity, allocates the contiguous event interval, and
commits the events and command outcome together. SQLite uses
`journal_mode=WAL` and `synchronous=FULL`. Reusing an opId with different
intent is rejected.

```text
CLI / GUI -> daemon -> RepoCell + writer-worker + writer-epoch fence
  -> validated events + frozen write plan
  -> required objects synchronized -> SQLite COMMIT
  -> acceptance receipt
  -> Git / worktree publication and read projection facets
```

## Acceptance and publication have separate receipts

`packages/kernel/src/composition/receipt-acceptance.ts` reads the committed
command outcome to build the acceptance receipt. A committed command outcome
establishes `accepted_durable`; Git, worktree, projection, and replica progress
are reported separately. A pending Git facet does not undo an accepted command.

`packages/kernel/src/store/sqlite-task-event-store.ts` schedules Git
publication after acceptance. It publishes events after the certified Git cut
and settles the authored worktree. Concurrent worktree edits remain visible as
conflicts rather than being overwritten. `ha receipt show <op-id> --wait
git_verified` can wait for Git publication; `ha doc materialize` settles
documents from canonical content.

Only the read projection is disposable. Preserve the canonical SQLite database
and its required objects; Git alone may lack accepted commands awaiting
publication. See [storage roles](00-overview.md) and [the read
projection](03-projection.md).

## Verify the native persistence boundary

`tools/stress/storage-campaign.integration.test.mjs` contains
`F01/sqlite-accept-sync-before-receipt`. With Linux strace, it asserts a
successful native `fsync` or `fdatasync` of `ledger.sqlite-wal` between the
final accepting write and the accepted receipt. It also injects write failures
and reopens SQLite to compare event and outcome atomicity. Run the existing
isolated test:

```sh
node tools/dispatch-isolated-test.mjs --file tools/stress/storage-campaign.integration.test.mjs
```

This checks the observed system-call boundary, not physical power-loss
behavior.
