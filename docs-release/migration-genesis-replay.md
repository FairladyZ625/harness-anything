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
| Legacy repository whose ledger predates the current generation         | `ha migrate import --source <source>` | Freeze writers, stop the source daemon, and use a committed source snapshot. Run `--dry-run` first.    | Five-category reconciliation has old == new, `skipped=0`, no authored `required` rows, and PASS.                                                          |
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

The order matters. Do not run the real import before the dry-run reports
`skipped=0` across all five entity classes, no authored `required` rows, and a
passing reconciliation.

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

The dry-run writes nothing. It prints a reconciliation table for five entity
classes — task / decision / fact / relation / coverage — each with four counts:
old / skipped / expected / new, plus a `Format validation: N skipped` line, an
`Attribution` line, and an authored coverage table.

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

Legacy `presets/**` are also `required`: rebuild each package in the current
`preset-manifest/v3` format and validate/install it through the preset commands.
Do not copy the v2 package into the new repository. Retain its original bytes in
the archive, then remove it only from the working source copy fed to the
importer.

A non-zero `skipped` count means some corpus entries do not satisfy the current
schema. For each entry, read the stated reason and fix the source data **on a
copy of the old repository**. Then re-run the dry-run until `skipped=0` for all
five classes.

Do not add a general-purpose mapping inside the product importer to absorb these
cases. A one-time historical artifact should not be hardened into product logic.
The fix belongs in the archived source data, applied on a copy.

### 5. Run the real import

```bash
ha migrate import --source <path-to-old-repo>
```

Acceptance: the five entity classes report old == new and skipped=0. If any
class does not, authored coverage has a `required` row, or reconciliation does
not pass, do not proceed on the new repository as-is — investigate, and if
needed discard the new repository and restart from step 2.

The command exits 1 while authored `required` rows remain, exits 3 when strict
format skips remain after authored reconciliation passes, and exits 0 only when
the full reconciliation passes.

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
No. The dry-run is how you find entries that will be skipped before the real
import runs, and the acceptance condition for the real import is skipped=0.
Fix the source data on a copy of the old repository and re-run the dry-run until
it is clean.

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
