---
name: harness-migration
description: Diagnose and migrate a Harness Anything ledger from a machine that does not have the current Harness installed. Use when a project's harness/ ledger predates the current generation, when daemon attach fails because a current ledger has pre-S4 doc cuts, or when a user asks to upgrade, migrate, replay, or repair an old Harness ledger. The skill first confirms the symptom really is a ledger-generation mismatch, then fetches the current source into a temporary location without disturbing an existing Harness install.
---

# Harness Migration

First confirm a broken `harness/` ledger actually has a generation mismatch
rather than some other fault. If it does, replay it into a freshly initialized
current-format repository; the source is never written to. Replay is the only
supported migration path — there is no in-place repair tool.

**This skill assumes nothing is installed.** It fetches the current source into
a throwaway directory and runs everything from there. A Harness installation
already on the machine — including a running daemon — is left untouched.

## Before anything: confirm this is the right document

This skill is versioned in the `harness-anything` repository as
`skills/harness-migration/SKILL.md` on **`main`**, and that branch is the
authority. **Read it from a git ref, never from whatever working tree happens to
be at hand** — a checkout parked on another branch may not carry this file at
all, or may carry an older revision, and neither difference is visible once the
text is in front of you.

```bash
git -C <any-checkout-of-harness-anything> show origin/main:skills/harness-migration/SKILL.md
```

A machine may also carry a separately maintained skill with a similar name —
`harness-ledger-migration` is the one that exists today, and it is an older,
**different** document rather than an alias. Following it instead is a silent
wrong turn. The front matter settles it: this skill's `name:` is exactly
`harness-migration`.

## The one rule that makes this work

**Every command runs against an isolated daemon user root.** Export it once and
keep it exported for the whole session:

```bash
export HARNESS_MIGRATION_WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/ha-migration.XXXXXX")" && pwd -P)"
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

The `cd … && pwd -P` wrapper around `mktemp` is what keeps the path readable. On
macOS `$TMPDIR` already ends in a slash, so the template produces a doubled
slash, and `/tmp` is itself a symlink into `/private/tmp`. Either way the raw
path turns up in every receipt from here on and does not match what you see on
the filesystem. `pwd -P` resolves both, once, at the start. Quoting is not
involved: `"${TMPDIR:-/tmp}"/ha-migration.XXXXXX` and
`"${TMPDIR:-/tmp}/ha-migration.XXXXXX"` are the same string to the shell, and
neither one avoids the doubled slash.

### If your shell does not persist between commands

The steps below accumulate exported variables and, in step 1, a shell function.
An agent that gets a **fresh shell per tool call keeps none of them** — the
second command runs with `HARNESS_DAEMON_USER_ROOT` unset and connects to the
machine's own daemon, which is exactly the failure this section exists to
prevent. This is the root cause of the downstream traps the later steps describe
individually (zsh word-splitting in step 1, `nohup` not seeing the function in
step 8, `env` resolving `ha` from `PATH` in step 9).

Write the session state to a file and source it at the start of every later
command:

```bash
export HARNESS_MIGRATION_ENV="$HARNESS_MIGRATION_WORK/env.sh"
cat > "$HARNESS_MIGRATION_ENV" <<EOF
export HARNESS_MIGRATION_WORK='$HARNESS_MIGRATION_WORK'
export HARNESS_MIGRATION_ENV='$HARNESS_MIGRATION_ENV'
export HARNESS_DAEMON_USER_ROOT='$HARNESS_DAEMON_USER_ROOT'
EOF
# every later command:  . "$HARNESS_MIGRATION_ENV" && <command>
```

Append each new `export` to that file as the steps below introduce it —
`HA_ENTRY`, `ARCHIVE_SOURCE`, `WORK_SOURCE`, `TARGET_REPO`, `DRY_RUN`,
`LEDGER_ARCHIVE`, `SOURCE_SHA_BEFORE`. Record `$HARNESS_MIGRATION_ENV` somewhere
you will still have it later; it is the one path you must not lose.

**Keep this file inside `$HARNESS_MIGRATION_WORK`, and if you write anything
anywhere else, put the repository name in its filename.** `mktemp` already makes
the work directory unique, but agents habitually drop scratch files into a
shared session scratchpad instead — and `env.sh`, `dry-run.txt` and `apply.log`
are the same name in every migration. When two migrations run in parallel, a
sibling overwriting your env file is not hypothetical: it has happened, and it
presents as your own variables quietly turning into someone else's, several
steps after the damage. Either keep everything under
`$HARNESS_MIGRATION_WORK`, or name it `env-<repo>.sh`, `dry-run-<repo>.txt`,
`apply-<repo>.log`.

## 1. Fetch the current source

**Node 24 or newer is required.** Check before cloning:

```bash
node --version
```

The CLI is run from its TypeScript entry point, which relies on Node's native
type stripping. On an older Node every command fails with

```
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
```

which reads like a missing build step and is not one — no amount of `npm run
build` fixes it. Stop and tell the user to upgrade Node; nothing below works
until they do.

```bash
cd "$HARNESS_MIGRATION_WORK"
git clone --depth 1 https://github.com/FairladyZ625/harness-anything.git ha-src
cd ha-src
npm install --no-audit --no-fund
export HA_ENTRY="$HARNESS_MIGRATION_WORK/ha-src/packages/cli/src/index.ts"
ha() { node "$HA_ENTRY" "$@"; }
ha --version
```

Expect a version line. The repository is about 10 MB and install takes seconds.

**`ha` here is a shell function, not an exported variable.** The obvious
`export HA="node …/index.ts"` followed by `$HA --version` works in bash and
silently fails in zsh, which does not word-split unquoted parameters: zsh passes
`node …/index.ts` as a **single** argument and the receipt comes back
`unsupported_command`. A function behaves identically in both shells.

If your shell does not persist between commands, append both the variable and
the function to the env file from the top of this skill, and source it every
time:

```bash
{ echo "export HA_ENTRY='$HA_ENTRY'"
  echo 'ha() { node "$HA_ENTRY" "$@"; }'; } >> "$HARNESS_MIGRATION_ENV"
```

Two consequences worth knowing now rather than at step 8:

- The function lives in the shell that defined it. Anything that runs in a
  **detached** process — see step 8 — must spell out `node "$HA_ENTRY" …`
  instead, and sourcing the env file does not change that.
- `env -u HARNESS_DAEMON_USER_ROOT ha …`, which step 9 uses on purpose, does
  **not** see the function. `env` execs a program, so it resolves `ha` from
  `PATH` — the machine's own installation. That is exactly what step 9 wants,
  and step 9 says so again where it matters.

**Do not look for `node_modules/.bin/ha`.** The published `bin` points at
`dist/`, which a source checkout does not contain, so the linked binary is
absent. Running the TypeScript entry directly is the supported path here and
needs no build step.

## 1a. Confirm the symptom is a ledger-generation mismatch before importing

Do this **after step 1 fetches the current source, before creating a destination
or running `migrate import`**. The symptoms below are an entry point, not a
decision: both kinds of ledger can produce them.

| What you see | What it means | Next action |
| --- | --- | --- |
| `doc event envelope or payload is invalid` | Could be either an older ledger or a current ledger with pre-S4 doc cuts. | Run the read-only event scan below. |
| daemon receipt `repo_attach_failed` or `repo_unavailable` while attaching the repository | The daemon could not build its projection; it does not identify the ledger generation. | Run the read-only event scan below; do not retry attach as a probe. |

Set the source path once. The scan only reads its event files; it does not need
the daemon and does not alter the source.

```bash
export ARCHIVE_SOURCE="$(cd /absolute/path/to/repository-with-harness && pwd -P)"
export CANONICAL_EVENT_CONTRACT="file://$HARNESS_MIGRATION_WORK/ha-src/packages/kernel/src/domain/doc-sync.contract.ts"
node --input-type=module - "$ARCHIVE_SOURCE/harness/events" "$CANONICAL_EVENT_CONTRACT" <<'NODE'
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [eventsRoot, contractUrl] = process.argv.slice(2);
const { parseCanonicalEvent } = await import(contractUrl);
const counts = { files: 0, parsed: 0, unknown_schema: 0, legacy_cut_shape: 0, other: 0 };
async function* eventFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) yield* eventFiles(file);
    else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'head.json') yield file;
  }
}
function hasLegacyCut(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasLegacyCut);
  const cut = value.baseLedgerSha;
  if (cut && typeof cut === 'object' && !Array.isArray(cut)) {
    const keys = Object.keys(cut).sort();
    if (keys.length === 2 && keys[0] === 'repoId' && keys[1] === 'sha') return true;
  }
  return Object.values(value).some(hasLegacyCut);
}
for await (const file of eventFiles(eventsRoot)) {
  counts.files++;
  let text, event;
  try {
    text = await readFile(file, 'utf8');
    event = JSON.parse(text);
    parseCanonicalEvent(text);
    counts.parsed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'canonical event schema is unknown') counts.unknown_schema++;
    else if (message === 'doc event envelope or payload is invalid' && event?.schema === 'doc-event/v1' && hasLegacyCut(event)) counts.legacy_cut_shape++;
    else counts.other++;
  }
}
console.log(JSON.stringify(counts, null, 2));
NODE
```

Interpret the counts conservatively:

- If `unknown_schema > 0` **or** `other > 0`, this is a previous-generation
  ledger rather than the narrow S4-only cut mismatch. Continue with the replay
  steps in this skill. The replay importer constructs current migration events
  rather than copying source event bytes.
- If `legacy_cut_shape > 0`, `unknown_schema = 0`, and `other = 0`, the ledger
  is a current-generation ledger whose doc cuts predate S4. Replay handles it,
  and replay is the only supported path: **there is no in-place restamp
  migration, and none is planned.** An in-place restamp was built and evaluated;
  it was deliberately not shipped, because a tool that rewrites cut identity in
  place has to be trusted on a ledger nobody can re-derive, while replay
  reconstructs the destination from source events and leaves the source
  untouched.

  Know what replay costs you here: it remaps entity IDs and writes a new
  ledger, which is more than this ledger strictly needs — only its cut identity
  is stale. Budget for the ID remapping (see the ID mapping steps below) rather
  than looking for a narrower tool. If remapped IDs are genuinely unacceptable
  for your ledger, stop and report that; do not improvise a hand-edit of event
  bytes.
- If all three failure counts are zero, the stream already parses under the
  current code. This is not a generation mismatch, so migration will not fix it;
  stop and investigate the reported symptom separately.

If the scan itself cannot read the events directory or run the current parser,
stop and report that failure. Do not infer the generation from `harness.yaml`:
both generations can carry `schema: harness-anything/v1`.

## 2. Freeze and back up the source ledger

Back up and digest **`harness/` only** — never the repository root.

```bash
export WORK_SOURCE="$HARNESS_MIGRATION_WORK/legacy-copy"
mkdir -p "$HARNESS_MIGRATION_WORK/backups" "$WORK_SOURCE"
export LEDGER_ARCHIVE="$HARNESS_MIGRATION_WORK/backups/legacy-harness.tar"
COPYFILE_DISABLE=1 tar -cf "$LEDGER_ARCHIVE" -C "$ARCHIVE_SOURCE" harness
export SOURCE_SHA_BEFORE="$(COPYFILE_DISABLE=1 tar -cf - --exclude='harness/.git' -C "$ARCHIVE_SOURCE" harness | shasum -a 256 | awk '{print $1}')"
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

The digest excludes `harness/.git` for the same reason the root digest is
excluded entirely: it is live metadata, not content. A `git fetch` from any
mirror or a background maintenance run rewrites `packed-refs`, `FETCH_HEAD` and
the reflog without touching a single ledger file, and the closing comparison
then fails for a reason unrelated to the importer. This bit a real migration —
an unrelated mirror fetch landed mid-run and the source looked modified when it
was not. **The archive is not filtered**: a backup must carry the ledger's own
git history, and only the digest needs the exclusion.

The digest and the `tar` print nothing while they run. On a **small ledger they
are effectively instant** — about a second each for a 963-event, 257 MB `harness/`
— so if you are staring at a blank prompt for more than a few seconds, look at
the size of what you are digesting rather than waiting. Only a genuinely large
ledger takes tens of seconds. Either way, if it runs for many minutes you are
digesting more than `harness/`; check the `-C` argument. Nothing may write to
`$ARCHIVE_SOURCE/harness/` while the migration runs, or the closing digest will
differ for a reason that has nothing to do with the importer.

Show the user `$LEDGER_ARCHIVE` and **stop until they confirm one independent
copy exists off this machine.** Migration is one-shot; this is the only point
where that confirmation is cheap.

If you are a dispatched agent with no way to reach the user, you cannot satisfy
that stop — say so rather than pretending you did. Record the archive path and
its size, state plainly in your report that the off-machine copy was never
confirmed, and continue. The rest of the migration writes only to
`$HARNESS_MIGRATION_WORK`, so nothing before step 9 can lose the source; step 9
is where the missing confirmation actually matters. **Only the confirmation is
waived, not step 9.** Unless your dispatch says otherwise, landing the ledger and
running the six landing checks are yours to do; carry the unconfirmed backup
forward as a stated caveat in your report instead of treating it as permission to
stop at step 8.

Every repair below targets `$WORK_SOURCE`. `$ARCHIVE_SOURCE` is read-only and
its `harness/` digest is re-checked at the end.

## 3. Initialize the destination

Ask the user for the new repository id, owner person id, and display name.

```bash
export TARGET_REPO="$HARNESS_MIGRATION_WORK/new-repository"
mkdir -p "$TARGET_REPO" && cd "$TARGET_REPO"
git init -q . && git commit -q --allow-empty -m "base"
ha init --repo-id <new-repo-id> --person-id <owner-person-id> --display-name '<display-name>'
```

Expect a receipt listing created paths and a commit sha. The first command in a
fresh user root starts an isolated daemon on its own; that is expected and it
belongs to this migration, not to the user's installation.

If init fails, move this directory aside and start a new empty one. Do not
repair a half-initialized target in place.

## 4. Dry-run and read the output

```bash
export DRY_RUN="$HARNESS_MIGRATION_WORK/dry-run.txt"
ha migrate import --source "$WORK_SOURCE" --dry-run > "$DRY_RUN" 2>&1; echo "exit=$?"
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

## 5. Resolve destination conflicts — one batch, one decision

`ha init` seeds README, ADR, milestone, walls and `people.yaml` files. A source
ledger usually has its own versions of those paths. Each conflict row prints
both sides and the exact flag to use:

```
| people.yaml | required | 1 | FAIL | destination content differs:
  source kind=file, source sha256=240b9a55…, source bytes=561;
  destination kind=file, destination sha256=39e0af13…, destination bytes=512;
  resolve with --resolve harness/people.yaml=destination|source |
```

**Handle every conflict in one pass. Never ask about them one at a time** — a
migration has a handful of these and each round trip costs the user an
interruption for a decision that is usually the same one.

Read both sides of all of them first:

```bash
CONFLICTS=($(grep -o -- '--resolve [^=]*=' "$DRY_RUN" | sed 's/--resolve //;s/=$//' | sort -u))
printf 'conflicts: %s\n' "${#CONFLICTS[@]}"
for c in "${CONFLICTS[@]}"; do
  printf '\n===== %s :: DESTINATION =====\n' "$c"; cat "$TARGET_REPO/$c" 2>/dev/null
  printf '\n===== %s :: SOURCE =====\n' "$c"; cat "$WORK_SOURCE/$c" 2>/dev/null
done
```

**The default is `destination` for every row.** The destination file is the
current format's skeleton and the migration exists to adopt it — a source file
that merely says the same thing in the old shape has nothing to preserve.

What the source file *may* have is project-specific substance the skeleton does
not carry: local conventions, routing rules, directory contracts, a
project's own standards. **Carry that content forward into the destination
file.** Merging is an edit you make, not something the importer does; the flag
is still `=destination`.

So present **one table** and ask for **one confirmation**:

| path | resolution | what carries over from the old file |
| --- | --- | --- |
| `harness/adr/README.md` | destination | when a lightweight ADR fits, `ha decision propose` for load-bearing choices, back-link rule |
| `harness/context/architecture/README.md` | destination | manifest read order, `architecture-check`, model update boundary |
| `harness/people.yaml` | **choose** | nothing — see below |

Say plainly: this is the default, and they can override any row to `source` if
they want the old file kept verbatim. One answer covers the whole table.

**`people.yaml` is the exception and must be asked.** It is the person roster,
and unlike every other row it is a genuine either/or where both answers lose
something. `destination` leaves the migrated history referencing people absent
from the new roster; `source` replaces the roster the new repository was
initialized with. Keep it as its own question inside the same message; do not
fold it into the default.

**Do not merge it, and do not hand-edit it either.** There is no write road for
this file. `doc sync` refuses it — the path is registered to `people-registry`,
so every submission comes back `blocked: path is owned by people-registry` — and
the owning command surface does not exist: `ha people --help` prints a heading
and **zero commands**, and `ha capabilities` has no `people` domain at all. A
hand-merged roster therefore can never be committed, and it leaves the ledger's
own working tree permanently dirty, which fails the landing check in step 9 and
the "Done when" list below. An operator who tries this loses the time twice:
once merging, once reverting.

So when the two rosters genuinely conflict: **pick one side with the flag**,
write the losing side's entries into your hand-over report so the information is
not lost, and tell the user they remain recoverable verbatim from the step 2
archive (`tar -xOf "$LEDGER_ARCHIVE" harness/people.yaml`). Reconciling the two
rosters is a task for the user, later, through whatever road exists by then —
not part of this migration.

**Do the merge edits after the final apply in step 8, not now.** Step 8
recreates the destination from scratch, which would discard anything edited
earlier. Record the third column now; apply it once at the end.

Collect the answers into repeated flags and re-run:

```bash
export RESOLVE_ARGS=(
  --resolve 'harness/context/README.md=destination'
  --resolve 'harness/people.yaml=source'
)
ha migrate import --source "$WORK_SOURCE" "${RESOLVE_ARGS[@]}" --dry-run > "$DRY_RUN" 2>&1; echo "exit=$?"
```

Each answer comes back as a row beginning `resolved: destination` or
`resolved: source`, carrying both digests so the discarded side stays visible.
A conflict left out of the flags stays `required`.

A directory target accepts only `=destination`. If `=source` reports that the
target is a directory, show the error and have the user handle that path.

## 6. Rebuild legacy presets as v3 packages

Legacy preset packages are not carried over — they are rebuilt against the
current format.

```bash
find "$WORK_SOURCE/harness/presets" -mindepth 1 -maxdepth 1 -type d | sort
ha preset inspect standard-task --profile baseline --vertical software/coding --locale en-US --json
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
  ha preset validate --source "$NEW_PRESET" --json
  ha preset install --source "$NEW_PRESET" --json
done
ha preset audit --vertical software/coding --json
```

Continue only when every validation reports `"valid": true` and the audit shows
no blocked package.

`preset audit --json` answers about the vertical as a whole — a count of
packages and a count of issues — not one row per package. So it tells you
*whether* something is blocked, not *which* package it is. The per-package
verdict is the `validate` output in the loop above; if the audit reports issues,
read back the validations rather than looking for a package list in the audit
receipt that is not there.

Then take the old packages out of the copy being imported — the archived
original still has them:

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
ha init --repo-id <new-repo-id> --person-id <owner-person-id> --display-name '<display-name>'
for NEW_PRESET in "$HARNESS_MIGRATION_WORK/rebuilt-presets"/*; do ha preset install --source "$NEW_PRESET" --json; done
ha migrate import --source "$WORK_SOURCE" "${RESOLVE_ARGS[@]}" --dry-run; echo "exit=$?"
```

Apply only when that exits zero, all five rows show `Old = Expected = New` with
`Skipped = 0`, authored coverage has no `required`, and reconciliation passes.

**Run apply detached, and poll it.** It prints **nothing at all** until it
finishes, so a foreground run is indistinguishable from a hang and any caller
with a command timeout will kill it partway. That has already happened once: an
agent harness terminated a real apply at around the 60-minute mark, and a
half-imported target is not recoverable — step 8 has to start over from
`ha init`.

**Budget from the event count, not from the worst case.** Apply costs roughly
200 ms per event and scales with the count, not with the byte size: a
963-event / 257 MB ledger finished in **211 seconds**, while a 21,000-event
ledger took **1h22m**. Multiply before you plan around it; treating every
migration as an overnight job over-provisions a small one by more than an order
of magnitude.

**Have the detached run record its own exit code.** A background process that
has already been reaped cannot be asked for its status from another shell — and
"apply exited zero" is a line in the "Done when" list, so an unrecoverable exit
code means the migration cannot be signed off. Write it to a file as the process
ends:

```bash
cat > "$HARNESS_MIGRATION_WORK/apply.sh" <<'EOF'
#!/bin/sh
node "$HA_ENTRY" migrate import --source "$WORK_SOURCE" "$@"
echo "exit=$?" > "$HARNESS_MIGRATION_WORK/apply-exit.txt"
EOF
chmod +x "$HARNESS_MIGRATION_WORK/apply.sh"

cd "$TARGET_REPO"
nohup "$HARNESS_MIGRATION_WORK/apply.sh" "${RESOLVE_ARGS[@]}" \
  > "$HARNESS_MIGRATION_WORK/apply.log" 2>&1 &
echo "apply pid=$!"
```

The wrapper is a file rather than an inline `sh -c` because `RESOLVE_ARGS` is a
shell array and does not survive being flattened into a quoted string. It reads
`HA_ENTRY`, `WORK_SOURCE`, `HARNESS_MIGRATION_WORK` and `HARNESS_DAEMON_USER_ROOT`
from the environment, so they must be **exported** — which they are, if you
followed the export blocks above. Note also `node "$HA_ENTRY"` rather than `ha`:
the shell function from step 1 does not exist inside `nohup`.

Poll for the exit file, not for the pid — the file is what survives:

```bash
if [ -f "$HARNESS_MIGRATION_WORK/apply-exit.txt" ]; then
  cat "$HARNESS_MIGRATION_WORK/apply-exit.txt"; tail -20 "$HARNESS_MIGRATION_WORK/apply.log"
else
  echo "still running"
fi
```

While it runs, `du -sh "$TARGET_REPO/harness"` and the commit count in
`$TARGET_REPO/harness` both climb — that is the only live progress signal there
is. A stalled apply shows neither growing for many minutes.

Once it has finished, confirm the source was never written to:

```bash
export SOURCE_SHA_AFTER="$(COPYFILE_DISABLE=1 tar -cf - --exclude='harness/.git' -C "$ARCHIVE_SOURCE" harness | shasum -a 256 | awk '{print $1}')"
test "$SOURCE_SHA_BEFORE" = "$SOURCE_SHA_AFTER" && echo "source ledger untouched"
```

The `--exclude` must match step 2's exactly. Digesting different sets on the two
sides guarantees a mismatch and tells you nothing.

If apply exits nonzero, keep its output, move the target aside, and restart from
a fresh `ha init`. **Never re-run apply against a partially imported target.**

**Then pack the new ledger's git repository.** The importer commits once per
event and never packs, so a freshly imported ledger is all loose objects — the
21,000-event migration produced **218,213 loose objects, zero packs, and an 18 GB
`.git`** for about 850 MB of actual content.

```bash
git -C "$TARGET_REPO/harness" gc --aggressive --prune=now
du -sh "$TARGET_REPO/harness/.git" "$TARGET_REPO/harness"
git -C "$TARGET_REPO/harness" rev-list --count HEAD
git -C "$TARGET_REPO/harness" fsck --no-progress
```

That run took the same ledger from 18 GB to a 181 MB `.git` in a single pack,
with the commit count unchanged and `fsck` clean. The effect holds at small
scale with the same shape and a far smaller bill: a 963-event ledger went from
**104 MB / 10,332 loose objects / 0 packs to 19 MB / 0 loose / 1 pack in about
7 seconds**, again with the commit count unchanged and `fsck` clean. Expect
seconds on a small ledger, not the long wait the 18 GB figure suggests.

Do this before step 9 either way — it is the difference between handing the user
a 19 GB directory and a 862 MB one, and after landing the daemon holds the
repository.

Now execute the merge column recorded in step 5. `$HARNESS_MIGRATION_WORK/preview-repository`
still holds the previous destination, and `$WORK_SOURCE` still holds the old
files, so both sides remain readable:

```bash
diff -u "$TARGET_REPO/harness/adr/README.md" "$WORK_SOURCE/harness/adr/README.md" | head -40
```

For each row, edit the destination file to carry the project-specific content
forward. Keep the current file's structure and add to it — do not paste the old
file over it, which would undo the resolution that was just applied. Show the
user the resulting diff. This is the last write of the migration.

## 9. Land the ledger

`$TARGET_REPO/harness` is a **standalone git repository** — its own `.git`, its
own history, its own remote. That is true in both placements below, and it is
the thing that must not be lost: a ledger is never a subdirectory of the
project's repository. One ledger, mirrored by the checkouts that use it.

**Local — the default.** The ledger lives inside the project directory as
`<project>/harness`, a repository of its own, and the project ignores it. This
is the shape `ha init` produces for a new project and the shape previous
generations used. Choose it unless the user says otherwise.

**Central.** The ledger lives outside any project, in a directory of its own,
and is registered by absolute path. Choose it when the user tells you the
ledger is shared — several machines mirroring one authoritative copy.

### First: the machine needs a current-generation CLI that outlives this work directory

**Read this before touching the destination.** Everything up to here ran from
`$HARNESS_MIGRATION_WORK`, which is disposable. The landed ledger is not: it
needs a daemon serving it from here on, and **that daemon must be the current
generation** — the whole reason for this migration is that the machine's
installed `ha` belongs to the previous one, and a previous-generation daemon
cannot serve a current-format ledger.

Check what the machine actually has — **do not assume it has nothing.** A
current-generation `ha` is often already installed, built from this repository
rather than from a registry:

```bash
env -u HARNESS_DAEMON_USER_ROOT command ha --version; echo "exit=$?"
```

A current-generation CLI prints a version and exits `0`. A previous-generation
one rejects the flag outright and exits nonzero:

```
{"ok":false,"command":"parse","error":{"code":"unknown_option",
 "hint":"Unknown option '--version' for 'ha'. Did you mean '--json'?"}}
```

**Route on whether the flag is accepted, never on the number it prints.** The
version string is `0.1.0` and carries no generation marker, so it is the same on
a current-generation global install and on the source checkout you have been
running all along — seeing `0.1.0` twice tells you nothing about which build is
which. Acceptance of `--version` is the whole signal; the number is noise.

**If the flag is accepted, use that installation** and skip to the `ha_serving`
block below. Running the migration checkout would also work, but handing the user
a command they already have beats handing them a checkout to maintain.

**If it rejects**, the installed CLI cannot serve what you are about to land, and
there is nothing to `npm install`: `@harness-anything/cli` is not published
(`npm view` returns 404). Two workable answers, in order of preference:

```bash
# preferred — build the checkout and install it on PATH, so `ha` just works
cd "$HARNESS_MIGRATION_WORK/ha-src/packages/cli" && npm run build && npm install -g .
command ha --version

# fallback — keep a durable checkout and invoke it by path
export HA_HOME="$HOME/.harness-cli-src"          # anywhere durable; not $HARNESS_MIGRATION_WORK
cp -R "$HARNESS_MIGRATION_WORK/ha-src" "$HA_HOME"
export HA_ENTRY="$HA_HOME/packages/cli/src/index.ts"
node "$HA_ENTRY" --version
```

The package's `bin` points into `dist/`, which a fresh clone does not contain —
that is why the global install needs an explicit `npm run build` first, and why
the skill has been running the TypeScript entry point directly up to now. A
build is all that is missing; it is not an unavailable artifact.

Whichever branch you took, **name the result once and use it for the rest of
step 9**, so the serving CLI and the throwaway migration entry point never get
confused for each other:

```bash
ha_serving() { command ha "$@"; }           # the machine's ha is current-generation
# ha_serving() { node "$HA_ENTRY" "$@"; }   # ...or the durable checkout instead
ha_serving --version
```

Hand the user that same invocation — the exact command that now drives this
ledger — and say plainly whether it replaces their existing `ha`. Do not leave
them to discover it the first time `ha task list` fails.

Note also that `env -u HARNESS_DAEMON_USER_ROOT ha …` below resolves `ha` from
`PATH`, which skips any shell function or alias the user has defined around it.
If theirs injects flags — `--actor`, a default `--root` — those are silently
dropped. This is not hypothetical: a real machine defines `ha` as a function
wrapping `command ha --actor human:<person>`, so commands run through `env` are
attributed to a different actor than the same commands typed by hand. Run
`type ha` before relying on either form, and write `command ha` when you mean
the binary.

The procedure below is the same for both placements. Only `LEDGER_HOME` differs.

```bash
# local (default) — the project directory the user is migrating
export LEDGER_HOME="/absolute/path/to/the/project"
# central — a directory of its own, outside every project
# export LEDGER_HOME="/absolute/path/the/user/chooses"

cd "$LEDGER_HOME"
# If the machine's own daemon already serves a ledger here, release it FIRST -- see below.
mv harness "harness.pre-migration-$(date +%Y%m%d-%H%M%S)"    # superseded, not disposable
cp -R "$TARGET_REPO/harness" ./harness
```

**If the destination is already a live Harness workspace, release it before the
`mv`, not after.** Everything up to here ran against the throwaway migration
daemon; the ledger you are replacing belongs to the machine's own daemon, which
is a different registry and is holding an open cell and a writer lock on the
directory you are about to move. Release it first, with `HARNESS_DAEMON_USER_ROOT`
**unset** so the commands reach that daemon rather than the migration one:

```bash
env -u HARNESS_DAEMON_USER_ROOT command ha daemon repo unregister --repo-id <existing-repo-id>
```

The daemon keeps running and keeps serving its other repositories; only this
ledger is released, which you can confirm by the writer lock next to it
disappearing. Then do the `mv` and `cp` above.

A destination with no Harness yet has nothing to release, and this step is
skipped.

**Move the old ledger aside; do not delete it.** The step 2 archive holds its
content, but the directory is also a git repository with its own history, and
this is the one moment in the migration where a mistake is discovered late. The
same reasoning already governs the old runtime directory below: report it, hand
over the path, and let the user delete it when they are satisfied. A rename is
reversible in one command; `rm -rf` against a directory the skill does not own
is not.

In a project, isolate the ledger from the project's own repository before
committing anything. `ha init` does this on a fresh project, but registering an
existing ledger does not, so do it here:

```bash
for rule in '/harness/' '/.harness/' '/harness.pre-migration-*/'; do
  grep -qxF "$rule" .gitignore 2>/dev/null || printf '%s\n' "$rule" >> .gitignore
done
git rm -r -q --cached --ignore-unmatch -- harness .harness
```

**The third rule is load-bearing, and so is checking the rules one at a time.**
The `mv` above leaves a `harness.pre-migration-<timestamp>/` directory sitting in
the project root, and `/harness/` does not match it — it matches only a directory
named exactly `harness`. Without its own rule that directory is untracked and
visible, so the `git add -A` below sweeps it into the project's index: at best a
39 MB ledger copy committed into the project, at worst — since it carries its own
`.git` — a broken gitlink to an embedded repository. It also makes the project
tree permanently non-empty, which means the `git status --porcelain` landing
check further down **can never pass**. Checking each rule individually matters
for the same reason: a single `git check-ignore -q harness` guard short-circuits
on projects that already ignored `harness/`, and those are precisely the projects
that have an old ledger to move aside.

The `git rm --cached` is not redundant either. `.gitignore` has no effect on
paths the index already tracks, so a project that had committed any part of the
old `harness/` keeps tracking it — and the ledger is private while the project
may well be public.

Then attach the landed ledger to the daemon that will actually serve it, and
commit the project side. **Start that daemon first** — `register` does not
autostart one, and against a stopped daemon it fails with:

```
error code=daemon_unavailable hint=connect ENOENT /var/folders/…/daemon-501-u-….sock
```

```bash
export HARNESS_DAEMON_USER_ROOT="$HOME/.harness"    # the serving root, not the migration one
ha_serving daemon start --service
ha_serving daemon repo register --repo-id <repo-id> --root "$LEDGER_HOME"
git add -A && git commit -m "adopt migrated ledger"    # local placement only
```

`ha_serving` is the function defined at the top of this step; the point is that
the register must not go through the **throwaway migration root** — its registry
dies with the work directory, and the command would succeed while leaving the
user with a ledger nothing serves. Overriding `HARNESS_DAEMON_USER_ROOT` to the
serving root, as the first line does, is what prevents that.

**The first attach is slow.** The daemon builds its projection over every event
in the ledger — for a 21,000-event ledger that took several minutes with no
output. Do not conclude it is stuck, and do not run it under a short timeout.

Reuse `<existing-repo-id>` if you released one; otherwise pick the id the user
wants. A previously released id is free to reuse at the new path.

`--root` takes `$LEDGER_HOME`, not `$LEDGER_HOME/harness`. Both are accepted and
resolve to the same canonical root, but the runtime's `.harness/` directory and
its writer lock are placed relative to the root you pass, and only the former
puts them where the ignore rules above expect them.

Check the landing before handing over. All six must hold:

```bash
test -d harness/.git                                   && echo "ledger has its own git"
git check-ignore -q harness                            && echo "project ignores the ledger"
test -z "$(git ls-files harness/ .harness/)"           && echo "project tracks no ledger file"
git --no-optional-locks status --porcelain             # project tree — expected: empty
git --no-optional-locks -C harness status --porcelain  # LEDGER tree — see below
ha_serving task create --title "landing check" --kind chore
```

The last one is the only proof that the ledger is writable where it now sits,
and it has to run against the **serving** daemon to prove anything — through the
migration daemon it would pass while telling you nothing about what the user
will actually experience. The others only prove the layout is right.

**The ledger tree check is not a formality.** The importer commits event data,
but the project-specific authored content merged at the end of step 8 is written
to the working tree and is **not** part of any commit. On a real migration this
left `governance/walls/walls.json` uncommitted — with the committed version
holding an empty `walls: []` array and seventeen governance walls existing only
in the unstaged file. One `git checkout` would have erased them silently.

If that tree is dirty, do not reach for `git commit` — read the next paragraph
first. Carry the content forward like this instead:

```bash
git --no-optional-locks -C harness status --porcelain      # the real list
ha_serving doc sync --submit --path <one-dirty-path>       # per prose file
```

**Take the list from `git`, not from `doc status`.** A bare `ha doc status` or
`ha doc sync --dry-run` does not enumerate every dirty authored file: with no
`--path`, the scanner keeps a dirty path only when it is prose (`.md` / `.txt`)
**or** its route is blocked, so a dirty file that is neither — any `.json` or
`.yaml` outside the route registry, `governance/walls/walls.json` being the case
that actually bit someone — is filtered out and never appears. The operator reads
an empty report, concludes there is nothing to carry over, and hands over a dirty
tree. The filter is one expression in
`packages/daemon/src/doc-sync-candidate-scanner.ts:13`.

Then sort the list by what each file can actually do:

- **Prose (`.md` / `.txt`), route allowed** — `doc sync --submit --path` accepts
  it. This is the road; naming the path explicitly is fine and expected.
- **Non-prose, route allowed** (`walls.json` and friends) — **there is no road.**
  Naming it does not help: the scanner blocks it a few lines later with `path is
  not canonical prose`. `--path` converts silence into a stated reason, which is
  worth doing so you know what you are looking at, but it does not make the file
  submittable. Leave it in the working tree, name it and its contents in the
  hand-over, and do **not** commit it — see the next paragraph for why that
  cure is worse than the disease.
- **Route blocked** (`people.yaml`, `harness.yaml`, anything under `events/` or
  `objects/`, task-package files) — the block reason names the owning command.
  For `people.yaml` that command does not exist yet; step 5 says what to do.

So keep the step 5 merge column to prose files wherever you have the choice. A
non-prose file in that column is content the migration cannot land.

**Never run `git commit` inside the ledger directory.** The ledger's HEAD must
be exactly the last event commit; the daemon derives that expectation from
`harness/events/head.json`, whose `opId` is the last event commit's message. Any
extra commit on top breaks the compare-and-swap and every write starts failing:

```
error code=publication_indeterminate hint=authored or canonical ref advanced outside
the daemon; reconcile before publishing: cannot lock ref 'refs/heads/master':
is at <your commit> but expected <last event commit>
```

Two things about that message are worth knowing in advance, because they cost a
real operator most of an hour:

- **Recovery takes both a `git reset` and a daemon restart, in that order, and
  neither alone is enough.** Reset back to the expected commit — the sha the
  message calls `expected`, which appears nowhere on disk to search for — then
  restart the daemon. `publication_indeterminate` is a fatal cell error: it
  latches the RepoCell and replays the cached failure on every later write, so
  after a reset alone you will still see the identical message and conclude the
  reset failed. It did not; the daemon is answering from a latch. Restarting
  without the reset fails too, because the ref really is wrong.
- **`reconcile` names no command.** There is no `ha reconcile`; the word
  describes an outcome, not a path. The recovery is the `git reset` above.

Editing files in the ledger tree without committing is safe: the daemon commits
by explicit pathspec and leaves unrelated working-tree changes alone.

Then tell them:

- their existing Harness installation was not modified;
- **which CLI now serves this ledger, spelled out as a command they can run** — whatever the probe at the top of this step settled on: their existing `ha` if it accepted `--version`, otherwise the newly installed one or the durable checkout, in which case say that their old `ha` will not work against this ledger;
- **any dirty file left in the ledger tree that has no write road** — name each one and what it contains, because a later `git checkout` there would erase it silently;
- **never `git commit` inside the ledger directory**, and what to do if they already have (the `git reset` above);
- the ledger is a git repository of its own, and the project must never track it;
- the migration daemon lives under the migration `HARNESS_DAEMON_USER_ROOT` and can be removed with the work directory;
- the previous ledger's git history is not carried forward — this migration rebuilds the ledger from its events, and the old history remains in the step 2 archive and in the `harness.pre-migration-*` directory beside the new one;
- that directory is theirs to delete once they are satisfied, and nothing in the migration depends on it any more — give them the path.

### Report the old runtime directory — do not delete it

The source repository has a `.harness/` directory beside the `harness/` ledger.
It is git-ignored runtime state and the importer never read it.

**It is no longer purely old state once you have landed a local placement.**
`daemon repo register --root "$LEDGER_HOME"` puts the new runtime directory at
`$LEDGER_HOME/.harness` — and in the default local placement `$LEDGER_HOME` *is*
`$ARCHIVE_SOURCE`, so from the moment you registered, the current generation's
live `cache/` sits in the same directory as the previous generation's dead
`write-journal/`, `task-holders/` and `script-runs/`. **Never describe this
directory as safe to remove wholesale, and never hand the user an `rm -rf` of
it**; that command would delete the working state of the ledger you just landed.
The narrow `staging`-only reclaim below stays safe under both placements because
it names paths the current generation does not use — that is why it names them
exactly. Under a central placement the two generations do live apart, but the
distinction is not worth relying on: the narrow command is correct either way.

On a long-lived repository the directory can be very large: previous generations
wrote a **full copy of the ledger** into a `staging/` directory on every script
or preset run and never removed them, so `.harness/` can reach hundreds of
gigabytes while the ledger itself is a fraction of that.

**Measure before quoting any of that.** The staging directories are the usual
culprit but not a given — on a repository where someone has already reclaimed
them, the cleanup below frees nothing and `cache/` and `write-journal/` are what
is left. Report the actual numbers:

```bash
du -sh "$ARCHIVE_SOURCE/.harness" "$ARCHIVE_SOURCE/harness"
du -sh "$ARCHIVE_SOURCE"/.harness/* 2>/dev/null | sort -rh | head
```

**Do not delete it, and do not offer to.** Report it and hand them the command:

```bash
# after you are satisfied with the new repository — reclaims the ledger copies,
# keeps each run's context/result/stderr metadata
chmod -R u+w "$ARCHIVE_SOURCE"/.harness/script-runs/*/staging \
             "$ARCHIVE_SOURCE"/.harness/evidence/presets/*/*/staging 2>/dev/null
rm -rf "$ARCHIVE_SOURCE"/.harness/script-runs/*/staging \
       "$ARCHIVE_SOURCE"/.harness/evidence/presets/*/*/staging
```

Name those two paths exactly. A shorter `.harness/*/staging` also matches
`.harness/preset-runs/staging`, which the **current** generation uses while a
run is in flight.

The `chmod` is not optional. Some staged copies contain read-only archives —
benchmark fixtures are stored `dr-xr-xr-x`/`-r--r--r--` on purpose — and `rm`
stops on them with `Permission denied`, leaving the reclaim silently partial.
Only the *copies* are made writable; the originals under `harness/` keep their
protection.

Deleting is theirs to decide, for two reasons worth saying out loud: the moment
right after a one-shot migration is exactly when the old installation is most
likely to be needed again, and this skill has no way to restore what it removes.
The same reasoning already governs why it does not stop their daemon.

Tell them the current generation does not accumulate this way — run staging now
holds a preset package rather than the ledger, and is removed on both the
success and failure paths.

## Done when

- Apply exited zero and the final dry-run had `Reconciliation: PASS`.
- All five entity classes show `Old = Expected = New`, `Skipped = 0`.
- Authored coverage has no `required` row.
- Every conflict appears as an explicit `resolved:` row.
- Every merge recorded in the step 5 table has been applied to the destination.
- Every legacy preset has a validated v3 replacement installed.
- `source-before` equals `source-after`.
- The ledger has its own `.git` at its landed location, the project tracks no
  ledger file, and `task create` succeeded there **through the serving daemon**.
- The ledger's own working tree holds nothing that had a write road and was not
  taken through it. Every prose file has gone through `doc sync --submit`; any
  file left dirty is one the CLI cannot accept, and it is named in the hand-over.
- The ledger's git repository has been packed (`git gc`) and `fsck` is clean.
- The user has been handed the exact command that now drives this ledger.
- The superseded `harness.pre-migration-*` directory still exists, and the user
  has been told where it is and that deleting it is theirs to decide.

## Known rough edges

- Connecting to a foreign daemon reports `missing_vertical` with
  `"origin":"daemon"`. The hint is readable text about an unavailable vertical,
  but it still does not name the real cause — a missing
  `HARNESS_DAEMON_USER_ROOT`. Route on the code and origin, not the wording.
- `--daemon-mode direct` does not support `init` — it rejects with
  `unsupported_command`. Isolation is done with the user root, not with direct mode.
- `daemon repo register` does not isolate a ledger from the project repository
  around it; only `ha init` does. That is why step 9 writes the ignore rules and
  runs `git rm --cached` by hand rather than trusting registration to do it.
- The writer lock is created as a sibling of the root you register — for a local
  placement that is `<parent-of-project>/<project-name>.harness-anything-writer.lock`.
  It is outside the project, so it does not dirty the working tree, but it is
  visible next to the project directory while the daemon holds the ledger.
- **`@harness-anything/cli` is not on a registry** — `npm view` returns 404 — so
  there is nothing to `npm install` by name. It is still installable: a fresh
  clone has no `dist/`, but `npm run build` produces one and `npm install -g .`
  puts a working `ha` on `PATH`. Many machines already have exactly that. Step 9
  probes for it before assuming otherwise.
- **The CLI version string does not identify a generation.** Both the current
  source checkout and a current-generation global install print `0.1.0`. What
  discriminates is whether `--version` is *accepted* at all: the previous
  generation rejects it with `unknown_option` and a nonzero exit. Never compare
  version numbers to decide which build you are talking to.
- **`ha people` has no commands.** `ha people --help` prints a heading and an
  empty list, and `ha capabilities` has no `people` domain, so `harness/people.yaml`
  has no write road at all — `doc sync` refuses it as owned by `people-registry`,
  and nothing else claims it. Roster conflicts are resolved by picking a side in
  step 5, not by merging.
- **`doc status` and `doc sync --dry-run` under-report dirty files.** With no
  `--path` they list only prose files and route-blocked paths, so a dirty
  non-prose authored file is silently absent. Take the list from
  `git -C harness status --porcelain` instead. Naming such a file with `--path`
  surfaces a `path is not canonical prose` block rather than submitting it —
  there is no road for non-prose authored content today.
- **`migrate import` prints nothing until it finishes** — no progress, no
  heartbeat. Run it detached (step 8), and have the wrapper record its exit code
  to a file: once the process is reaped, the exit status cannot be recovered from
  another shell, and "apply exited zero" is a sign-off condition. A half-imported
  target cannot be repaired, only discarded.
- **The importer never packs.** It commits once per event, so the delivered
  ledger is entirely loose objects: 218,213 of them and an 18 GB `.git` in one
  real migration; 10,332 and 104 MB in a small one. `git gc` is a required step,
  not an optimization.
- **`git commit` inside the ledger wedges every write** with
  `publication_indeterminate`, and the hint's word "reconcile" corresponds to no
  command. Recovery is `git reset` to the sha the message calls `expected`
  **followed by a daemon restart** — a reset alone leaves the cell latched and
  reproduces the identical error. See step 9.
- **The expected first read after an import is `status: "ready"` with a
  plausible row count.** Two real migrations of 695 and 963 events both answered
  immediately; treat a normal answer as normal and move on. The exception is
  large ledgers: the projection catches up 64 events per read call with no
  background driver, and the scan walks `events/<opId>.json` in filename order
  while the reducer needs contiguous revisions, so a large ledger can sit at a
  near-zero watermark for most of the catch-up and then complete all at once. A
  read in that state reports `outcome: "pending"` with `status`, `watermark` and
  `sourceRevision` in its evidence, and a `nextAction` naming the two revisions.
  **That is the import working, not failing** — keep issuing read commands, they
  are what drives it. Measured at ~193 ms per event, so 21k events is about an
  hour. Do not wait for a `pending` that is not going to come.
