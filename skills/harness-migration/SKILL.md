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
export HARNESS_MIGRATION_WORK="$(mktemp -d "${TMPDIR:-/tmp}"/ha-migration.XXXXXX)"
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

The quoting around `mktemp` is deliberate. On macOS `$TMPDIR` already ends in a
slash, so the more natural `"${TMPDIR:-/tmp}/ha-migration.XXXXXX"` yields a path
with a doubled slash in it. Harmless, but it appears in every path the migration
prints from here on, and it makes the receipts hard to read against the
filesystem.

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
git clone --depth 1 --branch rebuild/main https://github.com/FairladyZ625/harness-anything.git ha-src
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

Two consequences worth knowing now rather than at step 8:

- The function lives in this shell only. Anything that runs in a **detached**
  process — see step 8 — must spell out `node "$HA_ENTRY" …` instead.
- `env -u HARNESS_DAEMON_USER_ROOT ha …`, which step 9 uses on purpose, does
  **not** see the function. `env` execs a program, so it resolves `ha` from
  `PATH` — the machine's own installation. That is exactly what step 9 wants,
  and step 9 says so again where it matters.

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

On a large ledger the digest takes tens of seconds and prints nothing while it
runs — that is normal, do not kill it. If it runs for many minutes you are
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
is where the missing confirmation actually matters, and step 9 is not yours to
execute anyway.

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

**`people.yaml` is the exception and must be asked.** It is the person roster
and it cannot be merged — roster merging is not yet available — so it is a
genuine either/or where both answers lose something. `destination` leaves the
migrated history referencing people absent from the new roster; `source`
replaces the roster the new repository was initialized with. Keep it as its own
question inside the same message; do not fold it into the default.

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

**Run apply detached, and poll it.** On a large ledger it takes over an hour —
a 21,000-event ledger took 1h22m — and it prints **nothing at all** until it
finishes. There is no progress output to read, so a foreground run is
indistinguishable from a hang, and any caller with a command timeout will kill
it partway. That has already happened once: an agent harness terminated a real
apply at around the 60-minute mark, and a half-imported target is not
recoverable — step 8 has to start over from `ha init`.

```bash
cd "$TARGET_REPO"
nohup node "$HA_ENTRY" migrate import --source "$WORK_SOURCE" "${RESOLVE_ARGS[@]}" \
  > "$HARNESS_MIGRATION_WORK/apply.log" 2>&1 &
echo "apply pid=$!"
```

Note `node "$HA_ENTRY"` rather than `ha`: the shell function from step 1 does
not exist inside `nohup`.

Poll until the process is gone, then read the exit line out of the log:

```bash
ps -p <pid> >/dev/null && echo "still running" || tail -20 "$HARNESS_MIGRATION_WORK/apply.log"
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
with the commit count unchanged and `fsck` clean. Do this before step 9 — it is
the difference between handing the user a 19 GB directory and a 862 MB one, and
after landing the daemon holds the repository.

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

Check what the machine actually has:

```bash
env -u HARNESS_DAEMON_USER_ROOT command ha --version
```

A current-generation CLI prints a version. A previous-generation one rejects the
flag outright:

```
{"ok":false,"command":"parse","error":{"code":"unknown_option",
 "hint":"Unknown option '--version' for 'ha'. …"}}
```

If it rejects, **the installed CLI cannot serve what you are about to land**, and
there is no package to upgrade to: `@harness-anything/cli` is not on npm
(`npm view` returns 404), and a source checkout has no `dist/`, so the `bin`
entry points at a file that does not exist. The working answer today is to keep
a source checkout permanently and call it by path:

```bash
export HA_HOME="$HOME/.harness-cli-src"          # anywhere durable; not $HARNESS_MIGRATION_WORK
cp -R "$HARNESS_MIGRATION_WORK/ha-src" "$HA_HOME"
export HA_ENTRY="$HA_HOME/packages/cli/src/index.ts"
node "$HA_ENTRY" --version
```

Then hand the user that invocation, and say plainly that it replaces their
existing `ha` for this ledger. **This is a real rough edge, not a preference** —
until the CLI ships as an installable artifact, a migrated ledger is served by a
checkout the user has to keep. Tell them so rather than leaving them to discover
it the first time `ha task list` fails.

Note also that `env -u HARNESS_DAEMON_USER_ROOT ha …` below resolves `ha` from
`PATH`, which skips any shell function or alias the user has defined around it.
If theirs injects flags — `--actor`, a default `--root` — those are silently
dropped. Check `type ha` before relying on it, and use `command ha` explicitly
when you mean the binary.

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
env -u HARNESS_DAEMON_USER_ROOT ha daemon repo unregister --repo-id <existing-repo-id>
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
git check-ignore -q harness || printf '/harness/\n/.harness/\n' >> .gitignore
git rm -r -q --cached --ignore-unmatch -- harness .harness
```

The `git rm --cached` is not redundant. `.gitignore` has no effect on paths the
index already tracks, so a project that had committed any part of the old
`harness/` keeps tracking it — and the ledger is private while the project may
well be public.

Then attach the landed ledger to the daemon that will actually serve it, and
commit the project side. **Start that daemon first** — `register` does not
autostart one, and against a stopped daemon it fails with:

```
error code=daemon_unavailable hint=connect ENOENT /var/folders/…/daemon-501-u-….sock
```

```bash
export HARNESS_DAEMON_USER_ROOT="$HOME/.harness"    # the serving root, not the migration one
node "$HA_ENTRY" daemon start --service
node "$HA_ENTRY" daemon repo register --repo-id <repo-id> --root "$LEDGER_HOME"
git add -A && git commit -m "adopt migrated ledger"    # local placement only
```

If the machine's installed CLI *is* current-generation, `env -u
HARNESS_DAEMON_USER_ROOT ha daemon repo register …` does the same thing and is
shorter. Use whichever matches what you found at the top of this step; do not
register through the throwaway migration root either way — its registry dies
with the work directory, and the command would succeed while leaving the user
with a ledger nothing serves.

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
git --no-optional-locks -C harness status --porcelain  # LEDGER tree — expected: empty
node "$HA_ENTRY" task create --title "landing check" --kind chore
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
first, then carry the content forward by whatever CLI path owns those files.

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

- **Restarting the daemon does not fix it.** It re-reads the ref but not the
  expectation. The only recovery is `git reset` back to the expected commit —
  the sha the message calls `expected` — and that sha appears nowhere on disk to
  search for.
- **`reconcile` names no command.** There is no `ha reconcile`; the word
  describes an outcome, not a path. The recovery is the `git reset` above.

Editing files in the ledger tree without committing is safe: the daemon commits
by explicit pathspec and leaves unrelated working-tree changes alone.

Then tell them:

- their existing Harness installation was not modified;
- **which CLI now serves this ledger, spelled out as a command they can run** — if the machine's `ha` was previous-generation, that is the durable checkout from the top of this step, and their old `ha` will not work against this ledger;
- **never `git commit` inside the ledger directory**, and what to do if they already have (the `git reset` above);
- the ledger is a git repository of its own, and the project must never track it;
- the migration daemon lives under the migration `HARNESS_DAEMON_USER_ROOT` and can be removed with the work directory;
- the previous ledger's git history is not carried forward — this migration rebuilds the ledger from its events, and the old history remains in the step 2 archive and in the `harness.pre-migration-*` directory beside the new one;
- that directory is theirs to delete once they are satisfied, and nothing in the migration depends on it any more — give them the path.

### Report the old runtime directory — do not delete it

The source repository has a `.harness/` directory beside the `harness/` ledger.
It is git-ignored runtime state, the importer never read it, and none of it was
migrated. On a long-lived repository it can be very large: previous generations
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
- The ledger's own working tree is clean — no authored content left uncommitted.
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
- **There is no installable current-generation CLI.** `@harness-anything/cli` is
  not published (`npm view` → 404) and a source checkout has no `dist/`, so the
  package's own `bin` entry points at a missing file. A migrated ledger is
  therefore served by a source checkout the user has to keep around and invoke
  by path. Step 9 says how; there is no better answer available today.
- **`migrate import` prints nothing until it finishes** — no progress, no
  heartbeat, over an hour on a large ledger. Run it detached (step 8). A
  half-imported target cannot be repaired, only discarded.
- **The importer never packs.** It commits once per event, so the delivered
  ledger is entirely loose objects: 218,213 of them and an 18 GB `.git` in one
  real migration. `git gc` is a required step, not an optimization.
- **`git commit` inside the ledger wedges every write** with
  `publication_indeterminate`, restarting the daemon does not clear it, and the
  hint's word "reconcile" corresponds to no command. Recovery is `git reset` to
  the sha the message calls `expected`. See step 9.
- **`decision list` returns at most 100 rows** and does not say so — no
  pagination flag exists. A migrated ledger with more decisions than that is
  complete on disk while the CLI shows a truncated view.
- **Most read commands print only `<command>: applied`.** The rows are in the
  `--json` receipt's `evidence` field, as a JSON **string** needing a second
  parse. `doc sync --dry-run` is affected too, which makes the dry-run's whole
  purpose invisible unless you read the JSON.
