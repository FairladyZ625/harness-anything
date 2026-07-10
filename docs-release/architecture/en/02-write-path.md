# The single write path

[Gates and fail-closed](../../learn/en/03-gates-and-fail-closed.md) makes a
promise: no load-bearing write slips in unchecked, and there is exactly _one
door_ through which such writes pass. This page shows the machinery behind that
door — the write coordinator and the journal that stamps, applies, and commits
every accepted write.

## One door, by construction

Load-bearing writes — creating a task, transitioning its lifecycle, appending
progress, proposing or accepting a decision — never touch disk directly. They go
through a single component, the **write coordinator**, defined by the
`WriteCoordinator` interface in
`packages/kernel/src/ports/write-coordinator.ts`. The interface is tiny on
purpose:

```text
WriteCoordinator
  enqueue(op)  -> WriteAck     record intent in the journal
  flush(reason)-> FlushReport  apply pending ops, commit, watermark
  recover      -> RecoveryReport  replay anything left half-applied
```

Everything a caller can do is expressed as a `WriteOp`: an `opId`, an
`entityId`, a `kind`, and a payload. The `kind` is drawn from a closed
enumeration — task kinds (`package_create`, `transition_local`,
`progress_append`, `doc_write`, `package_archive`, `package_delete_hard`, …),
decision kinds (`decision_propose`, `decision_accept`, `decision_reject`,
`decision_relate`, `decision_retire`, …), a fact kind (`fact_invalidate`), and
module kinds. There is no "write these bytes to that path" primitive. If an
operation isn't one of the enumerated kinds, it cannot enter the system.

Callers don't even build ops by hand. The helpers in
`packages/kernel/src/write-coordination/write-helpers.ts`
(`writeCoordinatedTaskDocuments`, `writeCoordinatedPayload`) construct the op,
derive its `opId`, enqueue it, and flush — so every path into durable storage
funnels through the same two-step _enqueue then flush_.

Local CLI writes also have to enter with explicit actor attribution. The CLI
resolves it before it creates the coordinator. `HARNESS_ACTOR=agent:<id>` and
`HARNESS_ACTOR=system:<id>` remain valid environment channels, but a human
identity must use `--actor human:<id>` because child processes inherit
environment variables. The explicit flag wins over the environment value.
Local writes also need a git author name and email; examples set
`HARNESS_GIT_AUTHOR_NAME` and `HARNESS_GIT_AUTHOR_EMAIL` (the corresponding Git
author variables are accepted as fallbacks). If attribution or author data is
absent or malformed, the local write cannot proceed. The journal records whether
the actor came from `env` or `flag`. Daemon writes use the daemon's authenticated
human actor path, record `source: daemon`, and require that identity to resolve
to a git author email. See [Actor Attribution](../../actor-attribution.md).

## The journal: intent, then effect

The concrete coordinator is the **journaled** implementation in
`packages/kernel/src/store/write-journal-coordinator.ts`
(`makeJournaledWriteCoordinator`). It splits every write into two phases so that
a crash at any point leaves a recoverable state rather than a corrupt one.

**Enqueue** records _intent_. It validates the op, runs a preflight check, then
appends a journal record describing the op to an append-only journal file. The
op's payload is written out separately as a content-addressed blob, and the
record carries a `payloadHash` so the payload can be verified byte-for-byte
before it is ever applied. Nothing in the authored tree has changed yet — only
the journal knows a write is coming.

**Flush** produces the _effect_. Under a repository lock, it reads the durable
journal state, filters to records not yet applied, applies each one to disk,
commits the touched paths to git, and finally writes a **watermark**. The
watermark (`writeWatermarkDurably`) is the authoritative record of what has been
committed; the journal itself is compacted afterward as an optimization, and if
compaction fails the flush still succeeds because the watermark — not the
journal — is what replay trusts.

```text
enqueue                          flush
  validate op                      acquire repo lock
  preflight (paths don't collide)  read durable journal state
  write payload blob + hash        for each un-applied record:
  append journal record              verify payload hash
  (disk unchanged)                   apply write op to disk
                                      collect touched paths
                                    commit touched paths to git
                                    write watermark
                                    compact journal (best-effort)
```

## Atomic on disk: temp file, then rename

Individual file writes never leave a half-written file behind. The primitive is
`writeFileDurably` in `packages/kernel/src/store/write-journal-durable.ts`: it
writes the full body to a uniquely-named temp file (`.<pid>.<timestamp>.tmp`),
`fsync`s it, then `renameSync`s the temp file over the real path and `fsync`s
the containing directory. Because rename is atomic, a reader either sees the old
file or the new file — never a truncated one. The journal append itself is done
with an `fsync`ed append (`appendJsonLineDurably`), so a record is on stable
storage before it counts as intent.

The same temp-then-rename pattern reappears wherever a whole artifact is
replaced at once — including the SQLite projection (see
[03 · The projection: Markdown to SQLite](03-projection.md)), which is built into
a temp file and renamed into place.

## The watermark stamp

Every accepted write leaves a durable, attributable trace, and the watermark is
that trace. Two watermarks matter:

- The **write watermark** (`write-watermark/v1`) sits beside the journal and
  records `lastCommittedOpIds`, the `lastCommitSha`, and a `projectionHash`.
  This is how the coordinator knows, on the next run, which ops are already done
  and which need replaying.
- A **decision watermark** (`_coordinatorWatermark`) is stamped into the
  frontmatter of every decision document the coordinator writes. Because it is
  written _by_ the single write path, its presence and uniqueness are evidence
  that a decision file came through the coordinator rather than being
  hand-authored or copy-pasted. The post-merge checks in
  `packages/kernel/src/projection/post-merge-checks.ts`
  (`findDecisionWatermarkIssues`) hard-fail if a decision is missing its
  `_coordinatorWatermark`, or if two decisions share the same one.

Decision snapshots can also use that watermark as a compare-and-swap guard. A
snapshot write may carry an `expectedWatermark`; the write path reads the current
decision watermark just before replacing the file. If the current value does not
match the expected value, the write is rejected with `cas_watermark_mismatch`,
marked retryable, and no document is changed. At the CLI surface this is reported
through the normal `write_rejected` envelope, with the CAS reason as the cause to
refresh from.

One door means one place to stamp, and one stamp per accepted write means every
record can be traced back to the operation that produced it.

## Commit as part of the write

Committing to git is not a separate step a user is trusted to remember — it is
part of `flush`. Once the ops are applied, the coordinator commits exactly the
touched paths with a generated, semantic message (for example
`task(transition): <id> -> in_review [<opId>]`). The set of committed op ids is
threaded into the next watermark, so the git history and the watermark agree on
what happened. The result is that the source of truth (Markdown in git) and the
ledger of accepted writes advance together, in lockstep, under one lock.

## Rejection is the default

The write path inherits fail-closed behaviour from the top down. Validation
(`validateOp`) rejects an op with an empty `opId` or `entityId`, a
non-object payload, or a hard delete with no reason. Preflight
(`preflightWriteOp`) rejects writes whose document paths would collide. Payload
verification rejects any record whose bytes no longer hash to the recorded
`payloadHash`. A hard delete is refused outright for a task that is archived,
terminal, or still has inbound references (`assertHardDeleteAllowed`, which
consults the same disposition rules the [Disposition
Guard](../../learn/en/03-gates-and-fail-closed.md) enforces). Each of these
raises a rejection rather than writing anything — the safe default is "no."
Decision CAS mismatches are part of the same family: a stale expected watermark is
a retryable `cas_watermark_mismatch`, not a last-writer-wins overwrite.

## Crash recovery

Because intent and effect are separated and both are durable, an interrupted
write is not a lost or corrupt write — it is a _replayable_ one. On startup
`recover` re-runs `flush` for any journal records the watermark doesn't yet
cover, under the same lock. Two subtleties keep replay honest:

- **Non-idempotent appends** (a `progress_append` delta) get an
  `apply-marker/v1` line written the moment their file mutation lands. If a
  crash happens after the mutation but before the commit, replay sees the marker
  and skips re-writing the text — but still commits and watermarks the op, so
  the record completes exactly once.
- **Fact append deltas** have a narrower idempotence rule. Replaying the same
  formatted `fact-record/v1` with the same `fact_id` is a no-op; replaying the
  same id with different bytes is rejected as a duplicate.
- **The watermark is authoritative.** Replay trusts `lastCommittedOpIds`, never
  the possibly-stale journal, to decide what still needs doing.

The payoff is the invariant the whole system rests on: there is one door, the
door stamps and commits every write it lets through, and nothing that passes
through it can be left in a partial or unattributable state.
