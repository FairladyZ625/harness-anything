# Daemon read-side history origins

The historical source is the canonical ledger at locked Git cut `25483488a170d33fa2fc9d89e5bb887752a26a19` (`events/head.json` revision 28,966). Its five-event forensic surface was reduced to a committed, writer-stopped replay source cut `e9afab37de886ede25ed476178a7ac4c855c8c8d`: the subset keeps the three decision documents, two task indexes, one dispatch document, and the four source events needed by this gate. The source preparation explicitly records the task bootstrap's `occurredAt` as `bindingCreatedAt` and removes parent/relation references whose endpoints are outside the forensic subset; it does not change the preserved Task/v1 event bytes.

The production genesis replayer generated canonical Task/v2 destination cut `4a665d18f1fd7c5a4bafe8f3edb3837ac95c7924` (`events/head.json` revision 11). Every event file below is copied byte-for-byte from that new cut. The gate checks each fixture's Git blob SHA before parsing it. The four referenced content objects also come from the new cut and are checked against the events' SHA-256 and byte-size claims before the production reducer can read them. One content object uses a base64 transport file because it contains a historical private absolute path that cannot be stored as fixture plaintext. The gate decodes it before verifying and reducing the original bytes.

The task-bound runtime could not start an isolated daemon without bypassing `daemon_start_runtime_forbidden`, so the observed run invoked the same production `RepoCell` `migrate-import` action directly, without a fixture transformer or parser fork. Its operator-shell transport equivalent is `ha migrate import`. Starting from the committed revision-1 initialization cut `0eb6bea`, the observed generation commands were:

```sh
node /tmp/g3a-genesis-replay.m4GRFn/replay-driver-v2.mjs <disposable-destination> <locked-cut-forensic-subset> dry-run
node /tmp/g3a-genesis-replay.m4GRFn/replay-driver-v2.mjs <disposable-destination> <locked-cut-forensic-subset> apply
git -C <disposable-destination>/harness rev-parse HEAD
git -C <disposable-destination>/harness show 4a665d18f1fd7c5a4bafe8f3edb3837ac95c7924:events/<path>
```

The dry-run reconciled task 2/2, decision 3/3, fact 1/1, relation 2/2, and coverage 3/3 with zero skips. Its Task contract row was source v1 1, target v2 2, pinned preserved 0, pinned explicit false 2, and `imported_snapshot` 2.

The gate creates a disposable production `makeTaskProjection` SQLite database. Its test-only seam moves only `projection_meta.watermark` and `scanned_revision` to one less than the next frozen revision, then calls production `projection.apply` with the production write plan. The private production `reduceBatch` / `applyEvent` path therefore writes every projected field. Responses are then made by production projection reads and daemon assemblers (`makeTaskQueryReadModel`, `readProjectedDocument`, `listProjectedTaskDocuments`, `readTaskDispatches`, and `workspaceSummaryFromReads`); the gate does not reproduce row assembly.

## Frozen events

| Revision | Event id | Git blob SHA | Coverage supplied |
| ---: | --- | --- | --- |
| 2 | `event-0d4d85e05f103a7b4855ba76893d2986b41b3ff5dfa5c43ab65a835aec83df6c` | `04800ee383d7ac9e81899ca3cfe93c7e93f620af` | legacy decision row for `validateDaemonDecisionList`; decision counts for `validateDaemonWorkspaceSummary`; decision coverage for `validateDaemonRelationGraph` |
| 5 | `event-a21b9b5da3d9f438d9a6075294947b2deaf47d2b11986df29a8eac518703fd3c` | `85522ba6e58e6897558ee9f0a4e8c96b6f1b76d4` | fact row and fact anchor for `validateDaemonRelationGraph` |
| 7 | `event-c721eb4ac2e565c68f6cb458c77392ad0ff2fa368ef19ddc303c48ce43490553` | `4acbe8f97a47edbb3d370112d067541c5f9b1a1e` | Task/v2 row for `validateDaemonTaskSnapshotList`; task counts for `validateDaemonWorkspaceSummary`; planned task for `validateDaemonAgenda`; `INDEX.md` for `validateDaemonDocumentRead` and `validateDaemonTaskDocumentList`; dispatch owner state for `validateDaemonTaskDispatches` |
| 8 | `event-023aba2339afd97dedd4b04d4a77d3cf14c90257822b274443943f6b649d3a2d` | `63907d14d7bf0062051b72604ff213501e206c10` | relation edge for `validateDaemonRelationGraph` |
| 10 | `event-5d9e1903ef050c11053c84d60ec23a18d509d26801f47b6110c3f5f98521665c` | `7f85e62008db6861c260c1c11b637a1e6964365e` | archived dispatch document for `validateDaemonTaskDispatches`; archived task documents for `validateDaemonTaskDocumentList` |

Frozen event count: **5** (budget: 300). The gate enforces an **8,000 ms** wall-clock budget for projection plus validation.

## Validator coverage and exclusions

| Validator | Historical projected stock exercised |
| --- | --- |
| `validateDaemonTaskSnapshotList` | one bootstrap task row |
| `validateDaemonWorkspaceSummary` | one task and one decision |
| `validateDaemonAgenda` | one dispatchable planned task |
| `validateDaemonRelationGraph` | one relation edge, one fact/anchor, and decision coverage |
| `validateDaemonDecisionList` | `dec_LEDGER_E1`, whose historical event has no `provenance` key; today's projector emits `provenance: []` |
| `validateDaemonDocumentRead` | the bootstrap task's projected `INDEX.md` |
| `validateDaemonTaskDocumentList` | bootstrap documents plus archived dispatch documents |
| `validateDaemonTaskDispatches` | one persisted `runtime-dispatch/v1` document, assembled by the production dispatch read |

No validator is excluded: the earliest persisted dispatch at revision 23,764 needs only its task bootstrap plus the archive document under the continuity bypass, so its prerequisite set is 2 events rather than a chain over 23,764 revisions.

## Honest boundary

This gate does **not** cover stream control: batch scanning, cursor progression, `watermark + 1` selection, gap stopping, or source-head continuity. Its event store throws if production tries to scan it. It protects only the reducer/SQLite/row-assembly-to-validator invariant for the listed historical bytes.

`readTaskDispatches` is covered through its durable projected-document branch. The optional local `.harness/runtime/dispatches/*.jsonl` overlay is ephemeral runtime state and is deliberately absent, so parsing or precedence defects confined to that overlay remain a residual risk.
