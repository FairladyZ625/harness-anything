# Legacy ledger conversion before activation

Generation 1 rejects unsupported historical shapes. Production commands that
rewrite accepted history in place, including fact rekey, event-shape migration,
dispatch-record migration, and ledger-layout migration, are retired.

Preserve the old repository and stop its writers before conversion. Keep its
original database, objects, authored Git history, and backup identity together.
A projection rebuild cannot repair an invalid canonical source.

The operator conversion API creates an immutable generation-0 snapshot at the
resolved local root's `store/imports/generation-0.snapshot.json`. It retains source
events and required objects with a source digest. `convertLegacyGeneration`
validates the converted plan before seeding an inactive generation-1 database.
Interrupted imports resume against the same source; a second completed conversion
imports zero events. An active generation cannot be reconverted.

`preflightCanonicalGeneration` checks the immutable source, import marker,
converted prefix, required objects, and zero pending historical rewrites. It records
`ledger.sqlite.activation.json` beside the accepting database. Later opens verify
the fixed prefix and allow subsequently accepted events. A nonempty generation
without its source evidence is refused.

After the Git document and segment-manifest follower has settled, run:

```sh
ha ledger reconcile --generation 1
```

Reconciliation uses the immutable import source plus ledger metadata, row digests,
command outcomes, objects, and actual Git read-back. Retain `matches=true` and two
matching cold rebuilds as cutover evidence. Follow the approved deployment runbook
for backup, daemon changeover, canary receipt, and rollback; there is no live
historical-rewrite recovery command.

A rollback must preserve commands accepted after the backup cut. Restoring a Git
tag alone cannot restore SQLite acceptance, and discarding the canonical database
would lose those commands. Keep writes stopped until the owner has reconciled them.

For importing an older repository into a separate new destination, see
[genesis replay](migration-genesis-replay.md).
