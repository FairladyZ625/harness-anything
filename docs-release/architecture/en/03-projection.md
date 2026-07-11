# The projection: Markdown to SQLite

The [overview](../../learn/en/00-overview.md) rests on one shape, and
[01 · The three-primitive kernel](../../learn/en/01-three-primitive-kernel.md)
reads on the same assumption: Markdown in your git repo is the source of truth,
and SQLite is a **rebuildable projection** — a fast read cache you can delete and
regenerate from the Markdown at any time. This page shows how that projection is
built, what it contains, how staleness is detected, and why deleting it is
always safe.

## The source is Markdown; SQLite is derived

Nothing authoritative lives in the database. Every row in it is a mechanical
function of the Markdown files: Task and Decision records, typed relations,
Session manifests, Executions, and Reviews. The database exists only so
that reads — "which tasks are in review?", "what does this decision cover?" — can
be answered with an indexed query instead of re-parsing the whole tree. If the
database disagrees with the Markdown, the database is wrong by definition, and
the fix is always the same: throw it away and rebuild (ADR-0027 D1, D5).

## The rebuild flow

Rebuilding is a single pass, implemented by `rebuildTaskProjection` in
`packages/kernel/src/projection/sqlite-task-projection.ts`:

```text
scan Markdown            readMarkdownSource: task INDEX.md files
                         readDecisionProjectionRows: decision docs
   |
validate + convert       each entry -> a typed row (sorted)
                         (frontmatter must match its schema)
   |
hash                     sourceHash of the Markdown,
                         rowsHash + decisionRowsHash of the rows
   |
build relation graph     buildRelationGraphProjection:
                         edges, coverage, fact anchors
   |
write fresh SQLite       writeProjectionDatabase into a temp file,
                         then renameSync into place (atomic)
```

Every rebuild produces a *complete, fresh* database — there is no incremental
in-place mutation to drift out of sync. The tables are created from scratch, all
rows inserted, indexes built, and the finished file swapped in atomically. The
write uses the same temp-then-rename discipline as the
[write path](02-write-path.md): `writeProjectionDatabase` builds the DB in a
`.<pid>.<timestamp>.tmp` file and `renameSync`s it over the real path, so a
reader never sees a half-built database.

## What the database holds

The projection has six base tables created in
`packages/kernel/src/projection/sqlite-projection-store.ts`, plus declaration-
derived tables for authored Session, Execution, and Review records:

| Table | Primary key | Holds |
|---|---|---|
| `projection_meta` | `key` | Key/value metadata: `version`, `sourceHash`, `rowsHash`, `decisionRowsHash` — the freshness fingerprints |
| `task_projection` | `task_id` | One row per task: `title`, `canonical_status`, `coordination_status`, `raw_status`, `package_disposition`, `closeout_readiness`, `lifecycle_engine`, `freshness`, `updated_at`, `source`, `source_path`, `vertical`, `preset`, `profile`, `module_key`, … |
| `decision_projection` | `decision_id` | One row per decision: `state`, `title`, `question`, `chosen_json`, `rejected_json`, `module_keys_json`, `product_line_keys_json`, `decided_at`, … |
| `relation_edges` | `relation_id` | One row per typed relation: `source_ref`, `target_ref`, `relation_type`, `direction`, `state`, and the full `row_json` |
| `relation_coverage` | `claim_ref` | Which decision claims are covered: `decision_ref`, `status` (`covered`/`uncovered`), `covering_fact_ref` |
| `task_fact_anchors` | `fact_ref` | Where each fact lives: `task_id`, `fact_id`, `source_path` |
| `session_projection` | `session_id` | Session lifecycle, runtime, archive status, and snapshot metadata |
| `execution_projection` | `execution_id` | Task/executor identity, state, Session bindings with capture ranges, Submission Packet, and OutputEvidence |
| `review_projection` | `review_id` | Reviewed Execution, reviewer, `evidence_checked`, rationale, findings, and verdict |

A handful of indexes sit on top so common queries stay fast. The important
boundary is that Execution bindings expose a stable `range_id` and inclusive
timestamp interval (`end_at` is null until sealed); legacy bindings expose
`capture_range: null` instead of inventing ownership by transcript search.
Submission and Review fields project directly, but projection never turns a
mechanical Evidence result into a semantic verdict (ADR-0027 D1, D5-D6).

## Freshness and staleness

Because the projection is derived, it can fall behind its source — after a
merge, after an edit, after pulling someone else's commits. Detecting that is
the job of the hashes in `projection_meta`.

On every read, `readTaskProjection` re-reads the Markdown, recomputes its hash,
and compares it to the stored `sourceHash`. It also recomputes `rowsHash` and
`decisionRowsHash` from the rows currently in the database and compares those to
what was recorded. The outcomes:

- **`sourceHash` matches** — the projection reflects the current Markdown; serve
  from it.
- **`sourceHash` differs** — the Markdown changed since the DB was built. The
  projection is *stale*; it is transparently rebuilt and the caller is warned.
- **The stored `rowsHash`/`decisionRowsHash` no longer match the rows in the
  DB** — the database was edited out of band. This is treated as *tampering*, a
  hard fail, and the DB is discarded and rebuilt from Markdown.
- **The DB is missing or unreadable** — it is simply rebuilt.

The same `sourceHash`/`rowsHash` comparison drives the post-merge checks in
`packages/kernel/src/projection/post-merge-checks.ts`, which flag a stale
projection after a merge and refuse to let generated artifacts (the `.harness`
working files, the `.projection.sqlite` cache) be committed to git at all
(`findTrackedGeneratedFiles`). The projection is a local cache; it does not
belong in the repository, and the checks enforce that.

## The relation graph

Two of the six tables — `relation_edges` and `relation_coverage`, plus
`task_fact_anchors` — hold the graph that ties the entities together. During a
rebuild, `buildRelationGraphProjection`
(`packages/kernel/src/projection/relation-graph-projection.ts`) reads the typed
relation records embedded in the Markdown, resolves each endpoint against the
known set of tasks, decisions, and facts, and materializes:

- **edges** — every typed relation as a row keyed by a deterministic
  `relation_id`, with `source_ref`, `target_ref`, `relation_type`, and
  `direction`;
- **coverage** — for each decision claim, whether a fact covers it
  (`covered`/`uncovered`) and which fact does;
- **fact anchors** — the task and file where each fact record physically lives.

Relations that point at a non-existent entity, form a cycle, or fail their
record-level rules are caught here and surfaced as hard failures — the graph is
only ever built from endpoints that actually exist.

## The database is disposable

This is the property everything above is designed to guarantee: **you can delete
the SQLite file and lose nothing.** The next read finds it missing and rebuilds
it from the Markdown; the next merge check rebuilds it if it is stale; an
out-of-band edit to the DB is detected and overwritten. The authored Markdown in
git is the single source of truth, and the projection is a pure, reproducible
function of it — which is exactly what makes "delete it and rebuild" a safe
operation rather than a data-loss event.
