---
schema: preset-document/v1
description: Replay a previous-generation Harness repository into a freshly initialized current repository without writing to the archived source.
whenToUse: Use for the complete ha migrate import workflow, including explicit destination conflicts, strict source repairs, and rebuilding legacy presets as v3 packages.
---
# Legacy Repository Migration

Use the importer as the classifier. Do not inventory the legacy repository or
invent preserve/rebuild/archive categories. Act only on `SKIP` and `REQUIRED`
rows printed by the command.

## 1. Freeze and back up the source

Ask the user for the absolute legacy repository path, then substitute it below.
Run:

```bash
ARCHIVE_SOURCE="$(cd /absolute/path/to/legacy-repository && pwd -P)"
MIGRATION_WORK="$(mktemp -d "${TMPDIR:-/tmp}/ha-genesis-replay.XXXXXX")"
WORK_SOURCE="$MIGRATION_WORK/legacy-copy"
BACKUP_DIR="$MIGRATION_WORK/backups"
TARGET_REPO="$MIGRATION_WORK/new-repository"
REBUILT_PRESETS="$MIGRATION_WORK/rebuilt-presets"
RESOLVE_ARGS=()
mkdir -p "$BACKUP_DIR" "$REBUILT_PRESETS"
SOURCE_SHA_BEFORE="$(COPYFILE_DISABLE=1 tar -cf - -C "$ARCHIVE_SOURCE" . | shasum -a 256 | awk '{print $1}')"
printf 'source-before %s\n' "$SOURCE_SHA_BEFORE"
git -C "$ARCHIVE_SOURCE" bundle create "$BACKUP_DIR/legacy.bundle" --all
git -C "$ARCHIVE_SOURCE" bundle verify "$BACKUP_DIR/legacy.bundle"
cp -a "$ARCHIVE_SOURCE" "$WORK_SOURCE"
```

Observe a 64-character `source-before` digest, successful bundle verification,
and a complete directory copy at `$WORK_SOURCE`. Show the two backup paths to
the user and stop until the user confirms that one independent copy is stored
off this machine. Never edit `$ARCHIVE_SOURCE`; all repairs below target
`$WORK_SOURCE`.

## 2. Initialize a preview destination

Ask the user for the new repository id, owner person id, display name, and
repository name. Substitute those values and run:

```bash
mkdir "$TARGET_REPO"
cd "$TARGET_REPO"
ha init --repo-id <new-repo-id> --person-id <owner-person-id> --display-name '<display-name>' --name '<repository-name>'
ha migrate --help
```

Observe the initialized paths, initial commit, and the help line containing
`ha migrate import --source <source> [--resolve <resolve>]... [--dry-run]`. If
initialization fails, move this preview directory aside, create a new empty
directory, and rerun `ha init`; do not repair an incomplete target in place.

## 3. Run and capture the first dry-run

Run:

```bash
DRY_RUN_REPORT="$MIGRATION_WORK/dry-run.txt"
if ha migrate import --source "$WORK_SOURCE" --dry-run >"$DRY_RUN_REPORT" 2>&1; then
  DRY_RUN_EXIT=0
else
  DRY_RUN_EXIT=$?
fi
cat "$DRY_RUN_REPORT"
printf 'dry-run-exit %s\n' "$DRY_RUN_EXIT"
```

Read only these output surfaces:

- the five task / decision / fact / relation / coverage rows;
- `Format validation` and every `SKIP` line;
- `Attribution`;
- the authored coverage table and every `REQUIRED` line;
- the final `Reconciliation` line.

Branch by output, not by a hand-made inventory:

- A destination-conflict `REQUIRED` row includes both node kinds, SHA-256
  digests and byte counts; link rows also include link targets. Continue with
  section 4.
- `REQUIRED presets/**` continues with section 5.
- Any other `REQUIRED` row is not covered by this workflow. Show the exact row
  to the user and stop rather than guessing.
- Any `SKIP` line continues with section 6.
- When there are no `REQUIRED` or `SKIP` lines, continue with section 7.

## 4. Resolve each destination conflict explicitly

For every conflict row, show the source and destination summaries to the user
and ask for exactly one answer: `destination` or `source`. Create one repeated
flag per answer; do not infer a default:

```bash
RESOLVE_ARGS=(
  --resolve 'repo-relative-path-from-report=destination'
  --resolve 'another-repo-relative-path-from-report=source'
)
if ha migrate import --source "$WORK_SOURCE" "${RESOLVE_ARGS[@]}" --dry-run >"$DRY_RUN_REPORT" 2>&1; then
  DRY_RUN_EXIT=0
else
  DRY_RUN_EXIT=$?
fi
cat "$DRY_RUN_REPORT"
```

Observe one row beginning `resolved: destination` or `resolved: source` for
every answer. `destination` keeps the initialized node and explicitly discards
the source node. `source` authorizes compare-and-replace of that one file or
symbolic link; a later target change makes import reject and require another
dry-run. A destination directory accepts only `destination`. If `source`
reports that the target is a directory, show the error to the user, have the
user handle that target path, and rerun the dry-run. An unmentioned conflict
stays `required`.

## 5. Rebuild every reported legacy preset as v3

List only the packages beneath the reported `presets/**` surface:

```bash
find "$WORK_SOURCE/harness/presets" -mindepth 1 -maxdepth 1 -type d -print | sort
ha preset inspect standard-task --profile baseline --vertical software/coding --locale en-US --json
```

For each listed package, read its `preset.json` and `PRESET.md`, create
`$REBUILT_PRESETS/<id>/preset.json` and `PRESET.md`, and apply this exact v3
mapping:

- Set `schema` to `preset-manifest/v3`. Keep the legacy identity and purpose in
  `id`, `title`, `vertical`, `version`, and `kind`.
- Add the required string `outputShape`. Use the legacy value when present;
  otherwise ask the user to choose the observable result shape.
- Keep `kernelVersionRange`. Make every top-level `capabilityImports` item
  exactly `{id, kind, version, required}`.
- Make every profile exactly `id`, `title`, optional `checkerProfile`, a string
  array `completionGates`, a `templateSelections` array, and optional
  profile-local `capabilityImports`. Each template selection is exactly
  `{slot, templateRef, materializeAs, localePolicy:{prefer,fallback}}`.
- A v3 script entrypoint is exactly `type: "script"`, a plain string `intent`,
  an input array of `{name,type,required}`, flat `requires`, `produces`, and
  `sideEffects` capability arrays, and `command`.
- Do not copy v2 raw-filesystem `reads` or `writes`, object-shaped `inputs` or
  `intent`, or nested capability selectors: v3 has no corresponding fields.
  Remove an entrypoint that depends on those discarded declarations instead of
  widening its authority. Keep its user-facing procedure in `PRESET.md` as
  command/output/branch guidance.

Validate and install each rebuilt package from the preview destination:

```bash
cd "$TARGET_REPO"
for NEW_PRESET in "$REBUILT_PRESETS"/*; do
  ha preset validate --source "$NEW_PRESET" --json
  ha preset install --source "$NEW_PRESET" --dry-run --json
  ha preset install --source "$NEW_PRESET" --json
done
ha preset audit --vertical software/coding --json
```

Continue only when every validation report says `"valid": true`, every install
reports no issues, and the audit has no blocked rebuilt package. Show a
`missing_template` result to the user and use a declaration from
`ha template list` or remove the selection with the user's approval. Show a
`missing_provider` result to the user and stop until a current provider is
explicitly named or the unsupported capability is removed. Do not invent a
provider, and do not copy the legacy package into the new repository.

After all reported legacy packages have valid installed replacements, retain
their source bytes beside the working copy and remove them only from the copy
being fed to the importer:

```bash
mv "$WORK_SOURCE/harness/presets" "$MIGRATION_WORK/legacy-presets-rebuilt"
```

Rerun section 3 with `"${RESOLVE_ARGS[@]}"` before `--dry-run`. The
`presets/**` `REQUIRED` row must disappear. The archived original and the moved
working-copy bytes remain available for audit.

## 6. Repair strict format failures on the working copy

Run:

```bash
grep '^- SKIP ' "$DRY_RUN_REPORT" || true
```

Show every line to the user. Each line names the rejected entity, source path,
and strict validation reason. Correct only that named record under
`$WORK_SOURCE`; if a valid value such as `occurredAt` cannot be recovered from
the record, ask the user for it. Never add a compatibility rule to the
importer. Then rerun the dry-run with all prior `--resolve` flags.

Exit code `3` means strict format failures remain. Repeat until
`Format validation: PASS`, every entity row has `Skipped = 0`, authored
coverage has no `required`, and `Reconciliation: PASS`.

## 7. Recreate the final destination and apply once

The accepted source repairs must be replayed into a newly initialized target.
Move the preview aside, initialize the same path with the same identity, and
reinstall the validated v3 packages:

```bash
cd "$MIGRATION_WORK"
mv "$TARGET_REPO" "$MIGRATION_WORK/preview-repository"
mkdir "$TARGET_REPO"
cd "$TARGET_REPO"
ha init --repo-id <new-repo-id> --person-id <owner-person-id> --display-name '<display-name>' --name '<repository-name>'
for NEW_PRESET in "$REBUILT_PRESETS"/*; do ha preset install --source "$NEW_PRESET" --json; done
if ha migrate import --source "$WORK_SOURCE" "${RESOLVE_ARGS[@]}" --dry-run >"$MIGRATION_WORK/final-dry-run.txt" 2>&1; then
  FINAL_DRY_EXIT=0
else
  FINAL_DRY_EXIT=$?
fi
cat "$MIGRATION_WORK/final-dry-run.txt"
```

Do not apply unless `FINAL_DRY_EXIT` is zero, all five rows have
`Old = Expected = New` and `Skipped = 0`, `Format validation: PASS`, authored
coverage has no `required`, and `Reconciliation: PASS`.

Then run the same command without `--dry-run`:

```bash
if ha migrate import --source "$WORK_SOURCE" "${RESOLVE_ARGS[@]}" >"$MIGRATION_WORK/apply.txt" 2>&1; then
  APPLY_EXIT=0
else
  APPLY_EXIT=$?
fi
cat "$MIGRATION_WORK/apply.txt"
printf 'apply-exit %s\n' "$APPLY_EXIT"
SOURCE_SHA_AFTER="$(COPYFILE_DISABLE=1 tar -cf - -C "$ARCHIVE_SOURCE" . | shasum -a 256 | awk '{print $1}')"
printf 'source-after %s\n' "$SOURCE_SHA_AFTER"
test "$SOURCE_SHA_BEFORE" = "$SOURCE_SHA_AFTER"
git status --short
```

If apply is nonzero, preserve its report, move the failed target aside, and
restart from a fresh `ha init`. Never rerun apply against a partially imported
target.

## Done when

- The final dry-run and apply both exit zero.
- For task, decision, fact, relation, and coverage, `Old = Expected = New` and
  `Skipped = 0`.
- `Format validation: PASS`, the `Attribution` line is present, authored
  coverage contains no `required`, and `Reconciliation: PASS`.
- Every destination choice appears as an explicit `resolved:` authored row.
- Every reported legacy preset has a valid installed v3 replacement, and none
  of its v2 package bytes were copied into the target.
- `source-before` equals `source-after` for the archived original.
