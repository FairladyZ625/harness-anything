# Ledger Migration: Genesis Replay

Status: required path for repositories whose ledger predates the current
generation of the Harness Anything record format. A separate in-place fact
rekey is available for repositories that are already canonical.

## What changed

The ledger format has changed by a generation. Records written by the previous
generation do not satisfy the current schema, and a legacy repository therefore
cannot be converted wholesale in place. Canonical repositories can still carry
the older task-local fact shape from the fact transition; that narrow backlog is
handled by the one-shot fact rekey command below.

The only supported path is **genesis replay**: archive the old repository as a
read-only reference, create a new empty repository, and replay the old corpus
into it as canonical migration events, in original `occurredAt` order.

The genesis-replay entry point is:

```
ha migrate import --source <source> [--resolve <repo-relative-path>=destination|source]... [--dry-run]
    Import a legacy Harness repository; resolve reported destination conflicts with repeated --resolve path=destination|source.
```

There are two migration inputs and exactly one command for each:

| Input                                                                  | Command                               | Preconditions                                                                                          | Acceptance                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy repository whose ledger predates the current generation         | `ha migrate import --source <source>` | Freeze writers, stop the source daemon, and use a committed source. A same-cut projection is used when present; otherwise the importer rebuilds a disposable oracle from committed events and authored packages. Run `--dry-run` first. | Active IDs satisfy source ⊆ target; each kind's difference equals derived + archived/retired; current-event pre-validation and claim coverage pass. |
| Already-canonical repository with task-local `fact/<task>/F-*` records | `ha migrate rekey-facts`              | Stop the repository daemon/writers and run against the committed canonical cut. Run `--dry-run` first. | Re-keyed facts and `produces` edges match the dry-run id-map; SQLite fact/relation counts are stable; `ha fact search` and `ha fact show <F-id>` succeed. |

Run the fact-only path once at the fleet center. The marker carries a ledger
epoch. Edge nodes and replicas must compare that epoch with their local
projection before replaying; when it is newer, they discard the projection and
perform a complete cold rebuild from the canonical cut. They do not run a
second rekey or invent replacement refs.

For anything beyond what this page states, run `ha migrate --help`.

## Why no in-place upgrade

An in-place upgrade would have to carry every historical record shape forward
forever, or silently rewrite history. Neither is acceptable for a ledger whose
value is being a trustworthy record. Genesis replay instead treats the old
repository as forensic material — frozen, read-only, permanently preserved — and
builds the new line from events that already satisfy the current schema.

This also has a failure property worth stating plainly: at every step of the
migration, the old repository is only ever read. If anything goes wrong, the old
repository is untouched and the recovery action is to discard the new repository
and start over. There is no point at which the migration can damage your source
data.

## The five steps

The order matters. Do not run the real import before the dry-run proves set
inclusion and the explained-difference equality for all five entity kinds, plus
current-event pre-validation and claim-coverage preservation. Skip and authored-directory
counts are not subtracted from the entity oracle. Destination-preimage conflicts
remain an independent write-safety condition and require explicit resolution.

### 1. Back up the old repository

This step is destructive-adjacent and must not be skipped. Make two independent
copies:

- a `git bundle` of the full history, and
- a complete directory clone.

Keep at least one copy off this machine. The old repository stays read-only for
the entire migration; it is never modified.

### 2. Create a new empty repository

```bash
ha init --repo-id <id> --person-id <id> --display-name <name>
```

This generates `harness/harness.yaml`, `harness/people.yaml`, and the
context/governance/adr/milestones skeletons, and registers the repository with
the daemon automatically.

### 3. Run the dry-run first

```bash
ha migrate import --source <path-to-old-repo> --dry-run
```

The dry-run writes nothing. When `.harness/cache/task.sqlite` exists, it reads
that projection at the same revision as `harness/events/head.json`. When it is
absent, the same command automatically builds a disposable projection from the
committed flat or sharded event ledger and overlays older authored packages.
It never writes the source or its Git refs. The report identifies this path as
`Oracle: rebuilt-source` and reconciles five active entity kinds —
task / decision / fact / relation / execution. Each row reports source active,
target included, difference, derived, archived, and retired. Passing means
source ⊆ target and difference = derived + archived/retired. Load-bearing
decision-claim coverage is preserved separately. Format, attribution, and
authored-directory rows are diagnostic.

For Task/v1 → Task/v2, a missing title is derived first from `task_plan.md` H1,
then `INDEX.md` H1. A missing `occurredAt` comes from the task's earliest
canonical event. The receipt records `derived_from` per field and sets
`provenance=imported_snapshot`. An entity that still cannot satisfy its strict
contract is restated with its original ID and fields as
`disposition=archived, reason=truth_gap`.

### 4. Resolve required rows and skips

A destination conflict remains `required` until the user chooses that exact
path explicitly. The row reports both node kinds, SHA-256 digests and byte
counts; symbolic-link rows also report link targets. Repeat `--resolve` once per
conflict:

```bash
ha migrate import --source <path-to-old-repo> \
  --resolve <repo-relative-path>=destination \
  --resolve <another-repo-relative-path>=source \
  --dry-run
```

`destination` keeps the initialized destination node and explicitly discards
the source version. `source` compare-and-replaces that one destination file or
symbolic link. If the destination changes after classification, import rejects
and requires a new dry-run. A destination directory supports `destination` but
not `source`; handle that path manually and dry-run again. Resolution flags for
missing, duplicate, normalized-different, non-conflicting, or no-longer-conflicting
paths are rejected.

Legacy `presets/**` remain only in the read-only forensic source and are not
activated in the destination. To keep using one, rebuild it in the current
`preset-manifest/v3` format and validate/install it through the preset commands.
Do not copy the v2 package into the new repository. Retain its original bytes in
the archive, then remove it only from the working source copy fed to the
importer.

Legacy-parser skips are observations only. They are not subtracted from the
same-cut oracle and no longer produce exit code 3. The importer first derives
from same-cut witnesses. A decision, execution, task with a missing parent, or
other strict entity that remains invalid is archived with its original ID and
fields. A relation with an unresolved endpoint or owner retains its relation ID
and is restated as `state=edge_retired, reason=truth_gap`. Every derivation and
disposition is recorded in the receipt, with up to 20 samples per kind in the
report. A non-zero class with no usable witness follows this archival rule; it
does not disappear or pause for another decision.

One known historical schedule writer stored a declaration claim whose blob
contains the full schedule while the event contract claims the definition
facet. The importer accepts that exact claim/definition mismatch only for its
disposable oracle, reports `ACCEPT schedule_definition_facet_mismatch` with
`treatment=accepted_truth_gap`, and keeps the archived source bytes unchanged.
Other unsupported event shapes fail with `unsupported_legacy_event`; preserve
the source and report the named event before retrying.

### 5. Run the real import

```bash
ha migrate import --source <path-to-old-repo>
```

Acceptance: source active IDs are a subset of target IDs for all five kinds;
each difference equals its derived plus archived/retired count; coverage and
current-event pre-validation pass. The command exits 1 if any of those checks fails and
0 when all pass. Skip and authored-audit rows neither change the expected count
nor produce exit code 3.

## What the migrated data is

This is the part most easily misunderstood, so it is worth being explicit.

**The replayed entities are native entities of the new line.** They can be
created against, modified, transitioned, and related exactly like anything else
in the new repository. Migration does not produce a read-only "historical data"
zone inside the new ledger.

**What stays read-only is the old repository**, in its role as the archived
forensic reference. It is retained permanently and no longer participates in
day-to-day reads or writes.

Each migrated entity carries three provenance markers:

- event `source` is `migration-import/v1`;
- `migratedFrom` points back to the original repository;
- `generation: v0` marks it as coming from the previous generation.

These markers survive subsequent writes. They answer the question "was this
record migrated, or was it natively produced on the new line?" for as long as
the record exists.

Events are replayed in the order of their original `occurredAt` timestamps.
History is not flattened onto the day of the migration; the timeline in the new
repository is the timeline the work actually happened on.

## If something fails

The failure model is simple because the old repository is read-only throughout:

- Any error at any step leaves the old repository exactly as it was.
- The rollback action is to discard the new repository and redo the migration.
  Nothing else needs to be undone.

This is the main advantage of genesis replay over an in-place upgrade: there is
no half-migrated state that can corrupt source data.

Use the report code and row as the repair instruction:

| Report | Action |
| --- | --- |
| `required` authored row | Supply the exact printed `--resolve path=destination|source` choice, then dry-run again. |
| `migration_projection_oracle_cut_mismatch` | Stop source writers and regenerate or remove the stale local projection; do not alter committed events. |
| `unsupported_legacy_event` | Preserve the source, capture the named event and schema, and report it as a missing compatibility fixture. |
| `migration_projection_rebuild_failed` | Preserve the source and use the nested cause to repair a missing/corrupt committed blob or report an unsupported invariant. |
| `ACCEPT schedule_definition_facet_mismatch` | No source repair is required. Confirm the warning is the known schedule facet variant and retain the forensic archive. |
| reconciliation `FAIL` or `invalid_write_plan` | Do not apply. Keep the full dry-run receipt and report the failing kind/event; a successful dry-run must not defer a write-plan failure to apply. |

## Fact-only rekey procedure

For an already-canonical repository, do not use genesis import. Stop its daemon
and all writers at a committed cut, then preview and apply the fact-only command:

```bash
ha migrate rekey-facts --dry-run --json
ha migrate rekey-facts --json
sqlite3 .harness/cache/projections.sqlite \
  'select count(*) from fact; select count(*) from relation;'
ha fact search
ha fact show <F-id>
```

The dry-run receipt is the id-map and expected count. The apply receipt records
the same map in the canonical event ledger, rewrites relation endpoints, adds a
`produces` edge for each known task owner, and removes task-local `facts.md`
files. Repeat apply is a no-op. If a legacy fact has no determinable owner, it
is rekeyed without a task edge and listed for later attribution; ownership is
never guessed.

## FAQ

**Is my old repository deleted or rewritten?**
No. It is archived as a read-only forensic reference and kept permanently. The
migration only reads from it.

**Can I keep using the old repository after migrating?**
The old repository is the reference copy. Day-to-day work moves to the new
repository; the old one no longer participates in reads or writes.

**Can I skip the dry-run?**
No. The dry-run fixes a same-cut or disposable rebuilt oracle and proves set
inclusion plus the per-kind explained-difference equality. Review the derived,
archived, and retired samples before applying the import.

**Are migrated records second-class?**
No. They are native entities of the new line, fully writable. The only
distinction is provenance: they carry `migration-import/v1`, `migratedFrom`, and
`generation: v0` markers, which persist across later writes.

**Will history show the migration date?**
No. Events replay under their original `occurredAt` timestamps, so the new
repository's timeline reflects when the work actually happened.

**A command or flag I need isn't on this page.**
This page only documents the migration surface described above. Run
`ha migrate --help` for the authoritative command description.
