---
name: harness-install
description: Install Harness Anything into a project and verify the full init flow end to end. Use whenever a user asks to install, set up, onboard, or initialize Harness Anything in a repository, or to verify that a fresh install actually works (init, daemon, first task, gate blocking a fake completion).
---

# Harness Install

## Goal

Take a repository from "no harness" to "harness working, verified" — and prove
it by watching the completion gate block an evidence-free completion. Do not
report success from command exit codes alone; the verification step below is
the definition of installed.

## Preconditions

1. Node.js >= 24 (`node --version`).
2. The target directory is a git repository (`git rev-parse --show-toplevel`).
   If it is not, ask before running `git init`.
3. The environment must NOT define `HARNESS_AUTHORITY_MANIFEST`. That variable
   binds a daemon to one specific production repository; if it leaks into a
   fresh project the daemon autostart fails with "Daemon unavailable". Check
   with `env | grep HARNESS_AUTHORITY_MANIFEST` and unset it for this shell if
   present.

## Install

Published package (preferred once available on npm):

```bash
npm install --save-dev harness-anything
npx harness-anything --help
```

From a source checkout (before the npm release, or for development builds):

```bash
# in the harness-anything checkout
npm install && npm run build
npm pack --workspace @harness-anything/cli
# in the target project
npm install --save-dev <path-to-generated-tarball>
```

Either way, `npx ha --help` (alias of `npx harness-anything --help`) must print
the command surface before you continue.

## Initialize

Writes to the ledger require explicit actor attribution. Set it before init
and keep it set for every subsequent command:

```bash
export HARNESS_ACTOR="agent:<your-agent-id>"      # or pass --actor human:<person-id>
export HARNESS_GIT_AUTHOR_NAME="<committer name>"
export HARNESS_GIT_AUTHOR_EMAIL="<committer email>"

npx ha init --name <project-name> --add-npm-scripts
```

`init` scaffolds `harness/` (the authored ledger, its own git history) and
`.harness/` (machine state, git-ignored). If the receipt reports a missing
machine identity, re-run `ha init` with the two GIT author variables set — it
registers the current host/uid credential in `~/.harness/people.yaml`.

## Daemon

The daemon starts automatically on the first write. To manage it explicitly:

```bash
npx ha daemon status --json
npx ha daemon start --service     # if status reports unreachable
```

## Verify (this step defines "installed")

1. Create a real task through a preset:

   ```bash
   npx ha task create --title "Install verification" --vertical software/coding --preset standard-task
   ```

2. Prove the accountability gate works — claim the task, then try to complete
   it with no submitted execution and no evidence:

   ```bash
   npx ha task claim <task-id>
   npx ha task complete <task-id>
   ```

   The completion MUST be rejected (missing submitted execution / review).
   A rejection here is the success signal: the gate blocked a fake completion.

3. Confirm reads work: `npx ha task show <task-id> --json` returns the task
   with `status` unchanged.

Report the three receipts (create ok, complete rejected with reason, show ok)
to the user as the installation proof.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Local CLI writes require explicit actor attribution` | `HARNESS_ACTOR` (or `--actor`) plus both `HARNESS_GIT_AUTHOR_*` variables are missing. Set them and retry. |
| `Local writes require a machine identity` | `ha init` ran without the GIT author variables. Re-run `ha init` with them set, or add the host/uid credential to `~/.harness/people.yaml`. |
| `Daemon unavailable ... connect ENOENT` on a fresh project | Almost always `HARNESS_AUTHORITY_MANIFEST` leaking from the environment (see Preconditions). Unset it, then retry; the isolated daemon autostarts. |
| Writes hang or report a held lock | Another daemon owns the global lock. `npx ha daemon status --json` shows the holder; do not delete lock files by hand. |
