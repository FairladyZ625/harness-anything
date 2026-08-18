---
name: harness-install
description: Install Harness Anything into a project that has never had it, from a machine with no prior installation. Use when a user wants to adopt, set up, install, or try Harness Anything on an existing or brand-new project, when a repository has no harness/ ledger yet, or when someone asks how to get started with harness-anything. Reads the project first, then initializes, then drives one real task to done so the install is proven rather than assumed.
---

# Harness Install

Adopt Harness Anything in a project that does not have it yet: read the project,
initialize a ledger, attach it to a daemon, and drive one real task all the way
to `done`.

**This skill assumes nothing is installed.** It fetches the current source and
runs everything from there. It ends with a working install the user keeps — not
a throwaway sandbox.

## Before anything: confirm this is the right document, and the right skill

This skill is versioned in the `harness-anything` repository as
`skills/harness-install/SKILL.md` on **`main`**, and that branch is the
authority. **Read it from a git ref, never from whatever working tree happens to
be at hand** — a checkout parked on another branch may not carry this file at
all, or may carry an older revision, and neither difference is visible once the
text is in front of you.

```bash
git -C <any-checkout-of-harness-anything> show origin/main:skills/harness-install/SKILL.md
```

The front matter settles identity: this skill's `name:` is exactly
`harness-install`.

**Then check you are not holding the wrong half of the pair.** There are two
adoption skills and they are not interchangeable:

```bash
ls -d <project>/harness <project>/.harness 2>/dev/null
```

- `<project>/harness/` **exists and contains a ledger** (`harness.yaml`, or
  `events/`, `tasks/`, `decisions/`) → **stop and use `harness-migration`
  instead.** That project already has a Harness generation on disk; this skill
  would initialize over the top of it. Migration is one-shot and archives the
  old ledger first; there is no way back once you have run `ha init` there.
- `<project>/harness/` exists but is something else entirely — a source
  directory the project happens to have named `harness` — → stop and ask the
  user. `ha init` writes into `harness/` and this is not a collision you get to
  resolve on their behalf.
- Neither exists → this skill.

## 0. Read the project before you install anything

**Do this first and do it from the disk, not from the user.** Half the choices
below have a right answer that is already sitting in the repository, and asking
for what you can read is how an install turns into an interview.

```bash
cd /absolute/path/to/the/project
git rev-parse --is-inside-work-tree 2>/dev/null || echo "NOT A GIT REPOSITORY"
git log --oneline -1 2>/dev/null || echo "NO COMMITS"
ls -a
ls .github/workflows 2>/dev/null
git shortlog -sne --all 2>/dev/null | head
git remote -v
```

What each answer changes:

| Reading | Consequence |
| --- | --- |
| **Not a git repository, or no commits** | `ha init` needs a git repository at the project root. Create one, and give it at least one commit, before step 3 — see the note there. |
| **`AGENTS.md` or `CLAUDE.md` already exists** | `ha init` will **preserve** yours and report it as `drifted`. The harness agent entry never lands. Step 4 exists entirely for this case. |
| **A `.gitignore` already exists** | `ha init` **appends** `/harness/` and `/.harness/`. Existing rules are untouched. Nothing to do, but expect `.gitignore` to show as modified afterwards. |
| **CI workflows present** | The `ci` completion gate has a real referent. Note the command CI runs; step 6 needs it. |
| **No CI at all** | The `ci` gate still exists in the default contract and is still satisfied by `--ci passed`. Say so plainly to the user rather than letting them think a check ran. |
| **More than one contributor in `shortlog`** | Read the independence rule in step 6 **before** promising anything about review. Identity is derived from the unix account, so "two people" on one machine is one person to the harness. |
| **A public `origin`** | The ledger must never be committed into this repository. Step 3's ignore rules are what prevent it; verify them rather than assuming. |
| **Build/test command** (`package.json` scripts, `Makefile`, `pyproject.toml`, …) | This is what the first task in step 6 should be about. A real first task teaches the loop; a task called "test" teaches nothing. |

Then ask the user only what the disk cannot answer — **in one message, not one
question at a time**:

1. A repository id (short, lowercase, stable — it names this workspace in the
   daemon registry).
2. Their person id and display name (see step 2 — this one is expensive to get
   wrong).
3. What the first real task should be, given what you found.

Do **not** offer them a choice of ledger placement. `ha init` puts the ledger at
`<project>/harness` as a git repository of its own, and that is the only shape
this skill installs. A ledger shared across machines from a directory of its own
is a real configuration, but it is reached by registering an existing ledger
elsewhere — not by `init` — and offering it here produces a promise the rest of
this document does not keep.

## 1. Get a working CLI

**Node 24 or newer and a working C/C++ toolchain are required.** Check both
before cloning:

```bash
node --version
command -v make g++ python3
```

The CLI is run from its TypeScript entry point, which relies on Node's native
type stripping. On an older Node every command fails with

```
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
```

which reads like a missing build step and is not one — no amount of `npm run
build` fixes it. Stop and tell the user to upgrade Node; nothing below works
until they do.

**The toolchain is not optional either, and this is the single most likely place
a clean machine stops.** The daemon statically imports `node-pty`, which is a
native addon with no prebuilt binary for most targets, so `npm install` compiles
it. Without `make`/`g++` the install fails partway:

```
npm error gyp ERR! stack Error: not found: make
npm error gyp ERR! cwd .../node_modules/node-pty
```

The failure is loud, but its consequence is not: `npm install` leaves
`node_modules` **empty**, and the next command reports a missing dependency
somewhere else entirely — `Cannot find package 'effect'` — which looks like a
broken lockfile rather than a missing compiler.

**Do not reach for `npm install --ignore-scripts` to get past it.** The install
then succeeds and every read-only command still works, so it looks like the fix.
It is not: the daemon crashes the moment it loads, with

```
Error: Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-arm64
```

and every write command comes back `daemon_bind_timeout` pointing at a socket
that will never open. Install the toolchain instead — on Debian/Ubuntu
`apt-get install -y build-essential python3`, on macOS `xcode-select --install`.
A container image with build tools already present (`node:24` rather than
`node:24-slim`) avoids the question entirely.

**First, check whether the machine already has a current `ha`**, and do not
assume it does not:

```bash
command ha --version; echo "exit=$?"
```

A current-generation CLI prints a version and exits `0` — use it, and skip the
clone. A previous-generation one rejects the flag outright:

```
{"ok":false,"command":"parse","error":{"code":"unknown_option",
 "hint":"Unknown option '--version' for 'ha'. Did you mean '--json'?"}}
```

**Route on whether the flag is accepted, never on the number it prints.** The
version string is `0.1.0` on both a source checkout and a current global
install, so the number discriminates nothing.

If `--version` is rejected, the machine is running a previous generation. That
is a migration situation for any repository it already serves — say so — but
this project has no ledger, so you may still proceed here **provided you
replace the installed CLI** with the one you are about to build. Two current
generations cannot serve the same user root.

```bash
export HA_SRC="$HOME/.harness-anything-src"
git clone --depth 1 --branch main https://github.com/FairladyZ625/harness-anything.git "$HA_SRC"
cd "$HA_SRC" && npm install --no-audit --no-fund
export HA_ENTRY="$HA_SRC/packages/cli/src/index.ts"
ha() { node "$HA_ENTRY" "$@"; }
ha --version
```

**Put the checkout somewhere durable, not in `mktemp -d`.** Unlike a migration,
this install has to keep working tomorrow: the ledger you are about to create
needs a daemon serving it, and that daemon is started from this entry point. A
checkout under `$TMPDIR` takes the user's install down with it at the next
reboot.

**`ha` here is a shell function, not an exported variable.** The obvious
`export HA="node …/index.ts"` followed by `$HA --version` works in bash and
silently fails in zsh, which does not word-split unquoted parameters: zsh passes
`node …/index.ts` as a **single** argument and the receipt comes back
`unsupported_command`. A function behaves identically in both shells.

If your shell does not persist between tool calls, write the state to a file and
source it every time — otherwise `HA_ENTRY` is unset on the second command and
nothing below works:

```bash
export HA_INSTALL_ENV="$HA_SRC/install-env.sh"
{ echo "export HA_SRC='$HA_SRC'"
  echo "export HA_ENTRY='$HA_ENTRY'"
  echo 'ha() { node "$HA_ENTRY" "$@"; }'; } > "$HA_INSTALL_ENV"
# every later command:  . "$HA_INSTALL_ENV" && <command>
```

Two things not to waste time on:

- **Do not look for `node_modules/.bin/ha`.** The published `bin` points at
  `dist/`, which a source checkout does not contain, so the linked binary is
  absent. Running the TypeScript entry directly is the supported path and needs
  no build step.
- **Do not `npm install @harness-anything/cli`.** It is not on a registry;
  `npm view` returns 404. If the user wants a plain `ha` on `PATH`, that is a
  build plus a local global install, offered at hand-over in step 7 — not a
  prerequisite here.

**Do not set `HARNESS_DAEMON_USER_ROOT`.** This is the one place an install
differs sharply from a migration: the migration skill isolates itself into a
throwaway daemon root precisely so it touches nothing, but an install that runs
under an isolated root produces a ledger **that nothing serves** once the
variable goes out of scope, and the failure appears days later as
`daemon_unavailable`. The default root (`$HOME/.harness`) is the correct target.
If the variable is already exported in your environment, unset it now:

```bash
unset HARNESS_DAEMON_USER_ROOT
```

## 2. Settle identity before writing it, because there is no write road back

`ha init` writes `harness/people.yaml` with the person id, display name, and a
credential binding. **That file has no write road.** `ha people --help` prints a
heading and zero commands, `ha capabilities` has no `people` domain at all, and
`doc sync` refuses the path as owned by `people-registry`. A hand-edit can never
be committed and leaves the ledger's working tree permanently dirty.

So the person id is effectively permanent from the moment step 3 runs. **Ask for
it, show the user what you are about to write, and get an answer** — do not
derive it from `git config user.name` and proceed. This is a stop-and-ask point.

What gets written, so you can show it:

```json
{ "personId": "<their answer>", "displayName": "<their answer>",
  "roles": ["owner"],
  "credentials": [{ "kind": "unix-socket-owner-boundary",
                    "issuer": "host:<hostname>", "subject": "<uid>" }] }
```

Read the credential out loud, because it is the constraint everything in step 6
bends around: **identity is derived from the unix account that opened the
socket.** It is not a flag, and no environment variable overrides it. One unix
account is one person, forever, no matter how many humans use the machine.

## 3. Initialize

If step 0 reported no git repository or no commits, fix that first — `ha init`
publishes into a git repository and has nothing to publish onto otherwise:

```bash
cd /absolute/path/to/the/project
git init -q .                                  # only if not already a repository
git commit -q --allow-empty -m "base"          # only if there are no commits
```

```bash
ha --root "$PWD" init --repo-id <repo-id> --person-id <person-id> --display-name '<Display Name>'
```

All three flags are required; there are no defaults. Expect a receipt like:

```
initialized harness at harness/harness.yaml
outcome: applied
created: ["harness/harness.yaml","harness/people.yaml", … ,"CLAUDE.md","AGENTS.md"]
updated: []
preserved: []
drifted: []
commit: <sha>
next: ha daemon repo register --repo-id <repo-id> --root "…"; ha --root "…" daemon status
```

Read four things off it and act on them:

- **`preserved` / `drifted` listing `AGENTS.md` or `CLAUDE.md`.** The project
  already had those files, they were left exactly as they were, and the harness
  agent entry **did not land**. This is the single most skippable failure in the
  whole install: everything reports success, and the agents that read `AGENTS.md`
  never learn the harness exists. Go to step 4.
- **`.gitignore` is not in `created`, but it was written anyway.** The receipt
  does not declare it. Confirm by hand — this is the rule that keeps a private
  ledger out of a public repository, so verify it rather than trusting the
  receipt's silence:

  ```bash
  git check-ignore -v harness .harness
  ```

- **The `next:` line tells you to run `ha daemon repo register`. You do not need
  to.** `init` has already registered the workspace; the line is stale
  advice. Confirm rather than obey:

  ```bash
  cat "$HOME/.harness/registry.json"
  ```

  The project should be listed with `"state": "enabled"`. Running the register
  command anyway is harmless, but treating a completed step as an outstanding one
  is how an agent invents work to do.
- **`commit:` is a commit in the ledger, not in the project.** `harness/` is a
  git repository of its own with its own history. Nothing was committed to the
  project — `AGENTS.md`, `CLAUDE.md` and `.gitignore` are sitting untracked or
  modified in the project tree, and committing them is the user's call.

One more property worth naming before it confuses someone: **the ledger's branch
comes from the machine's `init.defaultBranch`, not from the project's branch.**
A project on `main` routinely gets a ledger on `master`. That is not a
misconfiguration and it must not be "fixed" — the daemon binds to the branch
recorded in the registry, and renaming it out from under a running daemon
produces `publication_indeterminate` on the next write.

If `init` fails, do not repair a half-initialized project in place. Start again
from clean — and note that **deleting the project directory is not clean**, because
the writer lock is a **sibling of the root**, not a child of it:

```bash
ha daemon repo unregister --repo-id <repo-id>     # releases this workspace only
rm -rf <project>/harness <project>/.harness "<project>.harness-anything-writer.lock"
```

Release the workspace rather than reaching for `ha daemon stop`: on a machine
that already had Harness, the daemon is serving the user's other repositories
too, and stopping it interrupts work you are not responsible for restoring.
`stop` is only the right verb when `registry.json` lists nothing else.

Skip the lock and the retry fails with `error code=writer_rejected hint=Workspace
writer lock is held for <project>: EEXIST … '<project>.harness-anything-writer.lock'`,
which names the path but reads like a concurrency problem rather than debris from
the attempt you just abandoned. Also drop the half-written `/harness/` and
`/.harness/` lines from `.gitignore` if you are starting the project over rather
than just re-running `init`.

## 4. Carry the agent entry into an existing `AGENTS.md`

**Only when step 3 reported `AGENTS.md` or `CLAUDE.md` as preserved/drifted.**

The canonical text is a template, so read it from the CLI rather than
transcribing it from a repository you happen to have open:

```bash
for REF in agent-base agent-overlay claude-entry; do
  ha --root "$PWD" --json template render "template://repository/$REF@1" \
    | python3 -c 'import json,sys; e=json.loads(json.load(sys.stdin)["evidence"]); print(e.get("requiredAnchors")); print(e["body"])'
done
```

The `body` and the `requiredAnchors` list live **inside the parsed `evidence`**,
not at the top level of the receipt — see the note in step 5. `requiredAnchors`
names the section headings the composed entry is expected to contain.
`agent-base` is the deterministic base, `agent-overlay` is the software/coding
overlay; the file `ha init` writes on a clean project is the two of them
composed, with a trailing "Repository Specifics" section left for the project.

**Merge into the user's file; do not replace it.** Their `AGENTS.md` is why the
merge is necessary in the first place — it holds instructions their agents
already follow. Append the harness sections, keep every one of the
`requiredAnchors` headings intact, and fold the project's own rules into the
"Repository Specifics" section at the end.

Show the user the resulting diff before you move on. This is the second
stop-and-ask point: you are editing a file that governs how every agent behaves
in their repository.

## 5. Prove the install answers

```bash
ha --root "$PWD" --json daemon status | python3 -m json.tool
ha --root "$PWD" task list
```

`daemon status` should report the project with `"state":"attached"`, a
`generation`, and `queueDepth: 0`.

**Use `--json` for `daemon status`.** In text mode it prints the single word
`daemon` and nothing else — no repos, no pid, no state. It is not broken and it
is not telling you the daemon is unhealthy; the text renderer for that one
command emits nothing useful. Every field exists in the JSON receipt.

**Learn the receipt shape here, before you need it under pressure.** `daemon
status` is one of the few commands whose payload sits at the top level of the
JSON. For almost everything else — `task show`, `task list`, `decision propose`,
`decision list`, `template render` — the payload is under `evidence`, and
`evidence` is a **JSON-encoded string, not an object**. You parse twice:

```bash
ha --root "$PWD" --json task list | python3 -c 'import json,sys; print(json.loads(json.load(sys.stdin)["evidence"]))'
```

Reading `receipt["body"]` or `receipt["decisionId"]` directly raises `KeyError`
on a receipt that is perfectly fine, which is an easy half hour to lose. Every
JSON example below parses `evidence` for that reason.

`task list` on a fresh install prints an empty row set and `count=0` with
`status=ready`. That is the install answering, and it is the last thing you can
check without doing real work.

## 6. Drive one real task to `done`

**An install is not proven until a task reaches `done`.** Everything up to here
would look identical if the completion path were broken, and the completion path
is where every remaining surprise lives. Use the real task from step 0, not a
placeholder.

### First, the rule that decides the shape of this whole section

Completion requires an **Execution Review by an independent actor**. Reviewing
your own submission fails with:

```
error code=actor_unauthorized hint=Execution Review requires an independent transport-bound arbiter.
```

Independence is judged on the pair **(person, executor)**. The person half is
transport-derived from the unix account and cannot be changed. The executor half
is declared by the caller:

```bash
export HARNESS_ACTOR=agent:<id>     # must match agent:<alphanumeric . _ : - >
```

So the loop is closable by one human on one machine — **the working commands and
the review command must run under different `HARNESS_ACTOR` values**, and an
unset variable counts as its own distinct executor (`null`). Decide the two
values before you start and keep them straight; discovering this at the review
step means unpicking a submission.

Say plainly what that means, because it is a governance claim and not a trick:
the harness is recording that a *different executor* checked the work. If the
user expects a second *human* reviewer, this install does not give them one, and
no amount of executor juggling will — that needs a second unix account, or the
team server. Tell them which of the two they have.

### The loop

```bash
export HARNESS_ACTOR=agent:worker
ha --root "$PWD" task create --title "<the real first task>" --kind <feat|fix|refactor|docs|test|chore>
```

The receipt prints the task id and package path. **Take the path from the
receipt.** The directory name is `<task-id>-<slug>` and the slug is derived, so
a hand-assembled path points at a directory that does not exist.

```bash
ha --root "$PWD" task transition <task-id> active
ha --root "$PWD" task start <task-id>
```

**`task start` takes the task id as a positional argument even though
`ha task --help` does not show it.** The usage line reads
`ha task start [--execution-id …] [--ttl-ms …] [--dry-run]`. Omitting the id
fails with `error code=missing_field hint=Run ha task start <task-id>`, which is
the correct instruction; the help text is what is wrong.

**Then recover the execution id, because `task start` does not print it.** In
text mode the entire receipt is `task-start: applied`. The lease is real and the
execution id exists, but a second `task start` will not reissue it — it fails
with `invalid_transition` / `the current round already has an active execution
or lease`. Read it back instead:

```bash
ha --root "$PWD" --json task show <task-id> | python3 -c 'import json,sys; print(json.loads(json.load(sys.stdin)["evidence"])["lease"]["executionId"])'
```

Now do the actual work the task is about. Then record what the run observed:

```bash
ha --root "$PWD" fact record --task <task-id> \
  --statement "<one checkable observation>" --source "<where it came from>"
```

Facts are optional `0..N`, not a quota. Record what a later reader would need and
stop.

### A decision, if the task settled one

The proposal is a JSON packet. **The packet shape is not discoverable from
`--help` or from the error messages, so it is written out here in full** — the
help line lists only the four input flags, the first error names the required
field names without their types, and the type errors (`decisionClass is
invalid`, `appliesTo must be an object`) name no legal values. Copy this and
edit it:

```json
{
  "title": "<short imperative title>",
  "question": "<the question, under 500 characters>",
  "riskTier": "low",
  "urgency": "low",
  "vertical": "software-coding",
  "preset": "software-coding",
  "decisionClass": "ordinary",
  "appliesTo": { "modules": [], "productLines": [] },
  "chosen":   [{ "id": "CH1", "text": "<what was chosen>", "rationale": "<why>" }],
  "rejected": [{ "id": "RJ1", "text": "<the real alternative>", "whyNot": "<why not>" }],
  "claims": [], "fulfillments": [], "relations": []
}
```

- `riskTier` and `urgency` are each `low` / `medium` / `high`.
- `decisionClass` is `ordinary` or `standing_policy` — nothing else.
- `chosen` and `rejected` are both **non-empty**, ids prefixed `CH` and `RJ`.
- `appliesTo` must be an object with exactly `modules` and `productLines`.

```bash
ha --root "$PWD" decision propose --from-file "$PWD/decision-packet.json" --body-file "$PWD/decision-body.md"
```

**Both files must live inside the project.** A packet written to the session
scratchpad or `$TMPDIR` is rejected with `error code=invalid_field
hint=fromFile must stay inside the workspace`, which the help text does not
mention. Write them at the project root and delete them afterwards; they are
inputs, not records.

**Take the decision id from that receipt.** The text receipt ends with
`decisionId=dec_…`; from `--json` it is `json.loads(receipt["evidence"])
["decisionId"]`, not `receipt["decisionId"]`. If you go looking in
`ha decision list` instead, note that its evidence keys the rows under
`decisions` while `task list` keys them under `rows`, so a parser written
against one raises `KeyError` on the other rather than returning nothing.

Relate it to the task, then accept it:

```bash
ha --root "$PWD" decision relate <decision-id> --anchor CH1 --type derives \
  --target task/<task-id> --rationale "<why this task follows from that choice>"

env -u HARNESS_ACTOR node "$HA_ENTRY" --root "$PWD" \
  decision transition active <decision-id> \
  --judgment-only "<why this is a judgment, not an evidenced claim>"
```

Two separate refusals guard that transition, and they are easy to confuse:

- Without either a claim-to-evidence relation or `--judgment-only`, it is
  refused with `decision accept requires a claim-to-evidence relation or
  --judgment-only <rationale>`. **`--judgment-only` is a recorded consent, not a
  bypass** — it writes a consent record naming the accepting actor. Use it when
  the choice really is a judgment; do not reach for it to get past the error.
- **Under the same `HARNESS_ACTOR` that proposed it**, it is refused with
  `error code=invalid_transition hint=An agent cannot judge its own Decision
  proposal.` — even with `--judgment-only`. The self-judgment guard is anchored
  on the **executor**, the same axis as the review rule above.

So the accept has to leave the working executor behind. **Clearing
`HARNESS_ACTOR` is the honest way to do it**, because a decision with no declared
agent executor is recorded as the human's own judgment, which is what accepting a
decision on the owner's behalf should mean. Note `env -u` execs a program and
therefore does **not** see the `ha` shell function from step 1 — spell out
`node "$HA_ENTRY"` there, or unset the variable in the shell and re-export it
afterwards.

If the user is present, this is a natural third stop-and-ask point: show them the
question, the chosen option, and the rejected alternative, and let them tell you
to accept it.

### Closeout, submission, review, consent, completion

The closeout file ships as a placeholder and `task complete` rejects placeholder
text. Write it **before** submitting, and land it through `doc sync` — editing
an authored file is not the same as recording it:

```bash
$EDITOR harness/tasks/<task-id>-<slug>/closeout.md      # Summary / Verification / Residual Risk
ha --root "$PWD" doc sync --submit --path "tasks/<task-id>-<slug>/closeout.md"
```

`--path` is relative to the **authored root** (`harness/`), not to the project.
A project-relative path is not found.

The submission packet has exactly seven fields, and the review packet exactly
five. Neither is documented anywhere but the rejection message:

```bash
cat > "$PWD/submission.json" <<EOF
{"completionClaim":"<what is now true>","deliverables":["<path or artifact>"],
 "outputs":["tasks/<task-id>-<slug>/closeout.md"],
 "verificationNotes":["<what you ran and what it said>"],
 "knownGaps":[],"residualRisks":[],"commitSha":"$(git rev-parse HEAD)"}
EOF
ha --root "$PWD" task submit <task-id> --execution-id <execution-id> --from-file "$PWD/submission.json"
```

```bash
cat > "$PWD/review.json" <<EOF
{"verdict":"approved","reason":"<what convinced you>",
 "evidenceChecked":["<what you actually looked at>"],
 "commitSha":"$(git rev-parse HEAD)","iteration":0}
EOF
HARNESS_ACTOR=agent:reviewer \
  ha --root "$PWD" --json task review-execution <task-id> --execution-id <execution-id> \
     --review-id review-1 --from-file "$PWD/review.json"
```

`verdict` is `approved`, `changes_requested`, or `dismissed`. `iteration` is `0`
or `1`. The `HARNESS_ACTOR` on that one command is what makes the review
independent — see the rule at the top of this section.

**Consent needs no packet.** The consent binds itself to the recorded Review —
the harness derives `reviewDigest` and `contentDigest` from the review you just
recorded, so there is nothing to copy or recompute:

```bash
ha --root "$PWD" task review-consent <task-id> --execution-id <execution-id> \
   --review-id review-1 --consent-id consent-1
```

(`--from-file` with both digests still works for pinning them yourself; a
mismatched digest is rejected.)

Consent is the owner's, so run it under the working actor, not the reviewer one.

```bash
ha --root "$PWD" task complete <task-id> --execution-id <execution-id> \
   --ci passed --commit-sha "$(git rev-parse HEAD)" --iteration 0 --path <repo-relative-source-path>
ha --root "$PWD" task list
```

`--ci passed` and `--path` satisfy the two completion gates the default coding
contract declares (`ci`, `code-doc-reconciliation`). **`--ci passed` is an
assertion you are making, not a check the harness runs.** If step 0 found a CI
command, run it and let the result decide what you pass; if it found none, tell
the user that this gate currently records a claim.

`task list` must now show the task as `done`. That, and nothing earlier, is the
install proven.

## 7. Hand over

Tell the user, in their own terms:

- **the exact command that drives this ledger** — the `ha` function and the path
  it points at, or their existing `ha` if step 1 found a current one. If they
  want a plain `ha` on `PATH`, it is
  `cd "$HA_SRC/packages/cli" && npm run build && npm install -g .`; say whether
  that replaces an existing installation;
- **the ledger is a git repository of its own** under `harness/`, the project
  ignores it, and it must never be committed into the project;
- **never run `git commit` inside `harness/`.** The ledger's HEAD must be the
  last event commit; an extra commit on top breaks the compare-and-swap and every
  later write fails with `publication_indeterminate`. Recovery is a `git reset`
  to the sha the error calls `expected` **followed by a daemon restart** — a
  reset alone leaves the daemon answering from a latched failure;
- **which files the install left uncommitted in the project** — `AGENTS.md`,
  `CLAUDE.md`, `.gitignore` — and that committing them is theirs to decide;
- **the two `HARNESS_ACTOR` values** the loop used, and that review independence
  is executor-based, not human-based, until they add a second unix account;
- where the first task's records now live, and how to read them back
  (`ha task list`, `ha task show`, `ha decision list`, `ha fact search`).

## Done when

- The project has `harness/` as a git repository of its own, and both ignore
  rules hold. Check them **one path per call** — `git check-ignore -q` accepts
  only a single pathname and fails with `fatal: --quiet is only valid with a
  single pathname` when given two, which reads like the check failing:

  ```bash
  for p in harness .harness; do git check-ignore -q "$p" && echo "ignored: $p"; done
  ```

- `git ls-files harness .harness` is empty — the project tracks no ledger file.
- `ha --json daemon status` reports the repo `attached`.
- If the project already had `AGENTS.md` or `CLAUDE.md`, the harness entry has
  been merged into it and the user has seen the diff.
- One real task reached `done` and `ha task list` shows it.
- That task carries a closeout that went through `doc sync --submit`, a
  submission, an independent review, a consent, and a completion.
- `git -C harness status --porcelain` is empty, or every remaining dirty file has
  been named to the user as having no write road.
- The user has been handed the exact command that now drives this ledger.

## Known rough edges

- **`ha daemon status` prints only the word `daemon` in text mode.** Every field
  is in the `--json` receipt. Do not read the text output as a health signal.
- **`ha task start`'s usage line omits the positional `<task-id>`** it requires.
  The runtime error names it correctly; the help does not.
- **`task start` does not print the execution id** it just issued, and a second
  `task start` refuses rather than reissuing. Recover it from
  `--json task show`, under `evidence.lease.executionId`.
- **`ha init` writes `.gitignore` without listing it** in the receipt's
  `created`. It appends when the file exists, so nothing is lost — but the one
  rule that keeps a private ledger out of a public repository is undeclared.
  Verify with `git check-ignore`.
- **`ha init`'s `next:` line tells you to register a workspace it already
  registered.** Check `registry.json` instead of following it.
- **`init` preserves an existing `AGENTS.md`/`CLAUDE.md` and reports it only as
  `drifted`.** Success and "your agents were never told about the harness" look
  identical from the receipt alone.
- **The ledger's branch comes from the machine's `init.defaultBranch`**, so a
  project on `main` normally gets a ledger on `master`. Leave it alone.
- **The decision proposal packet is not discoverable.** `--help` lists the input
  flags, the first rejection lists field names without types, and the type
  rejections name no legal values (`decisionClass is invalid` does not say
  `ordinary|standing_policy`). Step 6 carries the full shape for that reason.
- **`--from-file` and `--body-file` must resolve inside the workspace**
  (`invalid_field` / `fromFile must stay inside the workspace`). The help text
  does not say so, and a session scratchpad is the natural wrong place.
- **The submission and review packet shapes appear only in rejection hints**, and
  both hints call them a "proposal packet" regardless of which command produced
  them.
- **Execution Review rejects the submitting actor** with `actor_unauthorized`.
  Independence is `(personId, executor.id)`; the person half is transport-derived
  from the unix uid and no environment variable overrides it. `HARNESS_ACTOR`
  moves only the executor half.
- **`task complete` rejects placeholder closeout text** with
  `closeout_placeholder` and a `nextAction` telling you to edit the file. It does
  not tell you the edit must then go through `ha doc sync --submit --path`, which
  it must.
- **`harness/people.yaml` has no write road.** `ha people` has no commands,
  `ha capabilities` has no `people` domain, and `doc sync` refuses the path as
  owned by `people-registry`. Get the person id right at `init` time.
