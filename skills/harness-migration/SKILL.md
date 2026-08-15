---
name: harness-migration
description: Migrate a previous-generation Harness Anything repository into the current format, from a machine that does not have the current Harness installed. Use when a project's harness/ ledger predates the current generation, when ha commands fail against an existing repository because its layout is from an older release, or when a user asks to upgrade, migrate, or replay an old Harness ledger. Fetches the current source into a temporary location, so it works with no prior installation and does not disturb an existing Harness install.
---

# Harness Migration

Replay a previous-generation `harness/` ledger into a freshly initialized
current-format repository. The source is never written to.

**This skill assumes nothing is installed.** It fetches the current source into
a throwaway directory and runs everything from there. A Harness installation
already on the machine — including a running daemon — is left untouched.

## The one rule that makes this work

**Every command runs against an isolated daemon user root.** Export it once and
keep it exported for the whole session:

```bash
export HARNESS_MIGRATION_WORK="$(mktemp -d "${TMPDIR:-/tmp}/ha-migration.XXXXXX")"
export HARNESS_DAEMON_USER_ROOT="$HARNESS_MIGRATION_WORK/daemon-user-root"
mkdir -p "$HARNESS_DAEMON_USER_ROOT"
```

Without it, the CLI connects to whatever Harness daemon is already running on
the machine and that daemon serves a different generation of the code. The
failure does not announce itself as a conflict — it arrives as:

```
error code=missing_vertical
```

with `"origin":"daemon"` in the JSON receipt. **Match on those two fields, not on
the hint text**: the hint describes an unavailable vertical, which is true but
misleading, and it reads differently depending on which generation the running
daemon serves. `code=missing_vertical` together with `"origin":"daemon"` means
`HARNESS_DAEMON_USER_ROOT` is not set.

Do **not** stop or uninstall the user's existing Harness to work around it:
isolation is sufficient, and stopping their daemon interrupts work you are not
responsible for restoring.

## 1. Fetch the current source

```bash
cd "$HARNESS_MIGRATION_WORK"
git clone --depth 1 --branch rebuild/main https://github.com/FairladyZ625/harness-anything.git ha-src
cd ha-src
npm install --no-audit --no-fund
export HA="node $HARNESS_MIGRATION_WORK/ha-src/packages/cli/src/index.ts"
$HA --version
```

Expect a version line. The repository is about 10 MB and install takes seconds.

**Do not look for `node_modules/.bin/ha`.** The published `bin` points at
`dist/`, which a source checkout does not contain, so the linked binary is
absent. Running the TypeScript entry directly is the supported path here and
needs no build step.

## 2. Freeze and back up the source ledger

Ask the user for the absolute path of the repository holding the old `harness/`
directory.

Back up and digest **`harness/` only** — never the repository root.

```bash
export ARCHIVE_SOURCE="$(cd /absolute/path/to/legacy-repository && pwd -P)"
export WORK_SOURCE="$HARNESS_MIGRATION_WORK/legacy-copy"
mkdir -p "$HARNESS_MIGRATION_WORK/backups" "$WORK_SOURCE"
export LEDGER_ARCHIVE="$HARNESS_MIGRATION_WORK/backups/legacy-harness.tar"
COPYFILE_DISABLE=1 tar -cf "$LEDGER_ARCHIVE" -C "$ARCHIVE_SOURCE" harness
export SOURCE_SHA_BEFORE="$(COPYFILE_DISABLE=1 tar -cf - -C "$ARCHIVE_SOURCE" harness | shasum -a 256 | awk '{print $1}')"
printf 'source-before %s\n' "$SOURCE_SHA_BEFORE"
tar -xf "$LEDGER_ARCHIVE" -C "$WORK_SOURCE"
```

`$WORK_SOURCE` now contains `harness/` and nothing else, which is all the
importer reads — `--source` takes the repository root and descends into
`harness/` itself.

Three things this deliberately does **not** do, each for a reason worth knowing:

- **No `git bundle`.** `harness/` is its own git repository and the outer repo
  ignores it (`/harness/` in `.gitignore`, `git ls-files harness/` returns
  nothing). A bundle of the outer repo therefore contains **zero** ledger
  content — it looks like a backup and protects nothing.
- **No repository-root digest.** The root contains `.harness/`, which is
  ignored runtime state — locks, `write-journal`, `cache`, `script-runs`,
  `task-holders` — that any running daemon rewrites continuously. A root digest
  changes on its own between the before and after reads, so the "source
  untouched" check would report a false failure every time. A check that must be
  ignored to proceed is worse than no check.
- **No `cp -a` of the root.** It copies `node_modules` and the whole `.git`
  directory, which the importer never reads.

On a large ledger the digest takes tens of seconds and prints nothing while it
runs — that is normal, do not kill it. If it runs for many minutes you are
digesting more than `harness/`; check the `-C` argument. Nothing may write to
`$ARCHIVE_SOURCE/harness/` while the migration runs, or the closing digest will
differ for a reason that has nothing to do with the importer.

Show the user `$LEDGER_ARCHIVE` and **stop until they confirm one independent
copy exists off this machine.** Migration is one-shot; this is the only point
where that confirmation is cheap.

Every repair below targets `$WORK_SOURCE`. `$ARCHIVE_SOURCE` is read-only and
its `harness/` digest is re-checked at the end.

## 3. Initialize the destination

Ask the user for the new repository id, owner person id, and display name.

```bash
export TARGET_REPO="$HARNESS_MIGRATION_WORK/new-repository"
mkdir -p "$TARGET_REPO" && cd "$TARGET_REPO"
git init -q . && git commit -q --allow-empty -m "base"
$HA init --repo-id <new-repo-id> --person-id <owner-person-id> --display-name '<display-name>'
```

Expect a receipt listing created paths and a commit sha. The first command in a
fresh user root starts an isolated daemon on its own; that is expected and it
belongs to this migration, not to the user's installation.

If init fails, move this directory aside and start a new empty one. Do not
repair a half-initialized target in place.

## 4. Dry-run and read the output

```bash
export DRY_RUN="$HARNESS_MIGRATION_WORK/dry-run.txt"
$HA migrate import --source "$WORK_SOURCE" --dry-run > "$DRY_RUN" 2>&1; echo "exit=$?"
cat "$DRY_RUN"
```

**Use the importer as the classifier.** Do not inventory the old repository or
invent categories of your own. Act only on what the report prints:

- five entity rows (task / decision / fact / relation / coverage)
- `Format validation` and each `- SKIP` line
- `Attribution`
- the authored coverage table and each `required` row
- `Authored reconciliation`

Branch on those rows:

| What the report shows | Go to |
| --- | --- |
| a `required` row saying `destination content differs` | section 5 |
| `required` on `presets/**` | section 6 |
| any `- SKIP` line | section 7 |
| any other `required` row | show the exact row to the user and stop — this workflow does not cover it |
| no `required`, no `SKIP` | section 8 |

## 5. Resolve destination conflicts — ask, one at a time

`ha init` seeds README, ADR, milestone, walls and `people.yaml` files. A source
ledger usually has its own versions of those paths. Each conflict row prints
both sides and the exact flag to use:

```
| people.yaml | required | 1 | FAIL | destination content differs:
  source kind=file, source sha256=240b9a55…, source bytes=561;
  destination kind=file, destination sha256=39e0af13…, destination bytes=512;
  resolve with --resolve harness/people.yaml=destination|source |
```

For every conflict row, show the user both sides and ask for one answer:
`destination` (keep what `ha init` produced, discard the source version) or
`source` (replace with the source version). **Do not pick a default.** If it
helps them decide, print the two files.

Collect the answers into repeated flags and re-run:

```bash
export RESOLVE_ARGS=(
  --resolve 'harness/context/README.md=destination'
  --resolve 'harness/people.yaml=source'
)
$HA migrate import --source "$WORK_SOURCE" "${RESOLVE_ARGS[@]}" --dry-run > "$DRY_RUN" 2>&1; echo "exit=$?"
```

Each answer comes back as a row beginning `resolved: destination` or
`resolved: source`, carrying both digests so the discarded side stays visible.
A conflict left out of the flags stays `required`.

**`people.yaml` deserves a word to the user.** It is the person roster. Picking
`destination` means the migrated ledger's history references people who are not
in the new roster; picking `source` means the roster the new repository was
initialized with is replaced. Roster merging is not yet available, so say this
plainly and let them choose.

A directory target accepts only `=destination`. If `=source` reports that the
target is a directory, show the error and have the user handle that path.

## 6. Rebuild legacy presets as v3 packages

Legacy preset packages are not carried over — they are rebuilt against the
current format.

```bash
find "$WORK_SOURCE/harness/presets" -mindepth 1 -maxdepth 1 -type d | sort
$HA preset inspect standard-task --profile baseline --vertical software/coding --locale en-US --json
```

The `legacy-migration` preset bundled with the current release documents the
exact v2 → v3 field mapping. Read it:

```bash
cat "$HARNESS_MIGRATION_WORK/ha-src/packages/preset/assets/software-coding/presets/legacy-migration/PRESET.md"
```

Build each replacement under `$HARNESS_MIGRATION_WORK/rebuilt-presets/<id>/`,
then validate and install from the destination:

```bash
cd "$TARGET_REPO"
for NEW_PRESET in "$HARNESS_MIGRATION_WORK/rebuilt-presets"/*; do
  $HA preset validate --source "$NEW_PRESET" --json
  $HA preset install --source "$NEW_PRESET" --json
done
$HA preset audit --vertical software/coding --json
```

Continue only when every validation reports `"valid": true` and the audit shows
no blocked package. Then take the old packages out of the copy being imported —
the archived original still has them:

```bash
mv "$WORK_SOURCE/harness/presets" "$HARNESS_MIGRATION_WORK/legacy-presets-rebuilt"
```

Re-run the dry-run from section 4 with `"${RESOLVE_ARGS[@]}"`. The `presets/**`
row must be gone.

## 7. Repair strict format failures on the working copy

```bash
grep '^- SKIP ' "$DRY_RUN"
```

Each line names one rejected entity, its source path, and why strict validation
refused it — for example a decision whose `occurredAt` is invalid. Show every
line to the user.

Fix only the named record, **under `$WORK_SOURCE`**. If a value cannot be
recovered from the record itself, ask the user for it. **Never add a
compatibility rule to the importer** — a one-time historical artifact does not
belong in product logic.

Exit code `3` means strict failures remain. Repeat until `Format validation`
reports none and every entity row has `Skipped = 0`.

## 8. Recreate the destination, then apply once

Source repairs must be replayed into a target that never saw the broken data.

```bash
cd "$HARNESS_MIGRATION_WORK"
mv "$TARGET_REPO" "$HARNESS_MIGRATION_WORK/preview-repository"
mkdir -p "$TARGET_REPO" && cd "$TARGET_REPO"
git init -q . && git commit -q --allow-empty -m "base"
$HA init --repo-id <new-repo-id> --person-id <owner-person-id> --display-name '<display-name>'
for NEW_PRESET in "$HARNESS_MIGRATION_WORK/rebuilt-presets"/*; do $HA preset install --source "$NEW_PRESET" --json; done
$HA migrate import --source "$WORK_SOURCE" "${RESOLVE_ARGS[@]}" --dry-run; echo "exit=$?"
```

Apply only when that exits zero, all five rows show `Old = Expected = New` with
`Skipped = 0`, authored coverage has no `required`, and reconciliation passes.

```bash
$HA migrate import --source "$WORK_SOURCE" "${RESOLVE_ARGS[@]}"; echo "apply-exit=$?"
export SOURCE_SHA_AFTER="$(COPYFILE_DISABLE=1 tar -cf - -C "$ARCHIVE_SOURCE" harness | shasum -a 256 | awk '{print $1}')"
test "$SOURCE_SHA_BEFORE" = "$SOURCE_SHA_AFTER" && echo "source ledger untouched"
```

If apply exits nonzero, keep its output, move the target aside, and restart from
a fresh `ha init`. **Never re-run apply against a partially imported target.**

## 9. Hand over

Move `$TARGET_REPO` to where the user wants it, then tell them:

- their existing Harness installation was not modified;
- the migration daemon lives under `$HARNESS_DAEMON_USER_ROOT` and can be removed with the work directory;
- to use the new repository with their normal installation, register it there.

## Done when

- Apply exited zero and the final dry-run had `Reconciliation: PASS`.
- All five entity classes show `Old = Expected = New`, `Skipped = 0`.
- Authored coverage has no `required` row.
- Every conflict appears as an explicit `resolved:` row.
- Every legacy preset has a validated v3 replacement installed.
- `source-before` equals `source-after`.

## Known rough edges

- Connecting to a foreign daemon reports `missing_vertical` with
  `"origin":"daemon"`. The hint is readable text about an unavailable vertical,
  but it still does not name the real cause — a missing
  `HARNESS_DAEMON_USER_ROOT`. Route on the code and origin, not the wording.
- `--daemon-mode direct` does not support `init` — it rejects with
  `unsupported_command`. Isolation is done with the user root, not with direct mode.
