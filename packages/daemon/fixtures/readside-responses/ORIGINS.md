# Daemon read-side history origins

The source is the canonical ledger at the locked Git cut `25483488a170d33fa2fc9d89e5bb887752a26a19` (`events/head.json` revision 28,966). Every event file below is copied byte-for-byte from that tree: revisions and identities are not rewritten. The gate checks each fixture's Git blob SHA before parsing it. The 12 referenced content objects also come from the same cut and are checked against the events' SHA-256 and byte-size claims before the production reducer can read them. Three content objects use a base64 transport file: two intentionally lack a final newline, and one contains a historical private absolute path that cannot be stored as fixture plaintext. The gate decodes them before verifying and reducing the original bytes.

The gate creates a disposable production `makeTaskProjection` SQLite database. Its test-only seam moves only `projection_meta.watermark` and `scanned_revision` to one less than the next frozen revision, then calls production `projection.apply` with the production write plan. The private production `reduceBatch` / `applyEvent` path therefore writes every projected field. Responses are then made by production projection reads and daemon assemblers (`makeTaskQueryReadModel`, `readProjectedDocument`, `listProjectedTaskDocuments`, `readTaskDispatches`, and `workspaceSummaryFromReads`); the gate does not reproduce row assembly.

## Frozen events

| Revision | Event id | Git blob SHA | Coverage supplied |
| ---: | --- | --- | --- |
| 108 | `event-83528bd4ab507b4464f6367395476707fd11d8b055bafa53eb569e189f0d1f58` | `e4106ab9b385fafa88a929f7fb6ffb23b71d15c1` | legacy decision row for `validateDaemonDecisionList`; decision counts for `validateDaemonWorkspaceSummary`; decision coverage for `validateDaemonRelationGraph` |
| 710 | `event-01015fcbe88177fa28c1954658ece77399a587826b46832e159237aa554ebc3d` | `81f9a9ec2e1f64eb884e94933535dfc214e39633` | fact row and fact anchor for `validateDaemonRelationGraph` |
| 2,531 | `event-00dd108d8fb541de9a4b33835acf5438a8f8716a0bd27a61d16566e1d882fc61` | `ff8360db61bc6452420daba4d9f3913ba587a04b` | relation edge for `validateDaemonRelationGraph` |
| 23,742 | `event-5dbd4d8cd3dadd2834664be4e0a3a046bbe0657c572c38dc4a629444141d38ee` | `0b5cdf080a31435d58ec407b509f0a4ecbf23fb7` | task row for `validateDaemonTaskSnapshotList`; task counts for `validateDaemonWorkspaceSummary`; planned task for `validateDaemonAgenda`; `INDEX.md` for `validateDaemonDocumentRead` and `validateDaemonTaskDocumentList`; dispatch owner state for `validateDaemonTaskDispatches` |
| 23,764 | `event-64bdaa2ba1fac5c9fc3f214a9d14b7ce485664449fd127977beb4ab53b2961ad` | `0139e5a87941f40249e0e33e616e0fb2b0d037ef` | archived dispatch document for `validateDaemonTaskDispatches`; archived task documents for `validateDaemonTaskDocumentList` |

Frozen event count: **5** (budget: 300). The gate enforces a **5,000 ms** wall-clock budget for projection plus validation.

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
