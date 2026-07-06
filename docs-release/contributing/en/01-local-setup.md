# Local setup

## Prerequisites

Use the same baseline as the public docs:

- Node.js 24 or newer. CI covers Node 24 and Node 26.
- git.
- A clean source checkout of this repository.

From the repository root:

```bash
npm ci
```

There is no public npm package release yet. For product usage and local
development from source, follow the install path in
[start/install](../../start/en/01-install.md). For repository contribution, work
from the checkout and use the workspace scripts.

## Use a branch or worktree

Do not edit shared `main` directly. Start from the latest upstream state:

```bash
git fetch origin
git switch -c <branch-name> origin/main
```

Agent-authored implementation branches should use the repository convention:

```bash
git switch -c codex/<short-scope> origin/main
```

When running multiple agents or keeping local coordination separate from public
implementation, prefer a git worktree:

```bash
git worktree add .worktrees/<short-scope> -b codex/<short-scope> origin/main
```

Each concurrent agent gets its own branch or worktree. Two agents editing the
same working tree is treated as a coordination failure, not as a merge strategy.

## Keep public and local files separate

Public PRs may include repository code, tools, CI files, public docs, and
fixtures. They must not include:

- local agent entry files such as root `AGENTS.md` or `CLAUDE.md`;
- local harness or planning records that were not intentionally made public;
- generated cache directories;
- editor, Finder, OS, or machine-local files;
- secrets, tokens, private URLs, or absolute local paths.

Run `git status --short` before staging. Stage only the paths that belong to the
contribution.

## Command names

Use the current CLI command names:

```bash
ha <command>
npx harness-anything <command>
```

Do not use the stale `harness` / `npx harness` command surface for this checkout.

If you edit `packages/cli/src`, rebuild the workspace CLI before relying on the
workspace bin:

```bash
npm run build -w @harness-anything/cli
```

While iterating on CLI behavior, running the source entrypoint directly is also
valid:

```bash
node packages/cli/src/index.ts --json doctor
```

## Before you start coding

Write down the scope in one sentence. If you cannot state what files or behavior
the PR is allowed to change, narrow the work before editing. Contributions that
mix implementation, release posture, unrelated cleanup, and docs rewrites are
hard to review and likely to be sent back.
