# Install

## Prerequisites

- **Node.js 24 or newer.** The CLI is tested on Node 24 and 26.
- **git.** Harness Anything writes into a git repository and uses it as the source of truth.

Check your Node version:

```bash
node --version   # must be >= 24
```

## Install the CLI

There is no public npm release yet — the current distribution is a **local global install** from the source checkout. From the repository root:

```bash
npm ci
npm run build -w @harness-anything/cli
npm install -g ./packages/cli    # installs the `ha` command (and its `harness-anything` alias)
```

Confirm it's on your PATH:

```bash
$ ha --version
harness-anything 0.0.0
```

`ha` and `harness-anything` are the same command; `ha` is the short alias used throughout these docs.

## Check your environment

`ha doctor` is a read-only diagnostic. It reports your Node version, whether you're inside a git worktree, whether authored `harness/` state exists, and what to run next. It never creates or edits anything.

```bash
$ ha doctor
ok command=doctor summary="completed doctor"
```

Add `--json` for the full structured report.

## Troubleshooting

- **`ha: command not found`** — the global bin directory isn't on your PATH. Run `npm bin -g` to find it and add it to your shell profile.
- **Node too old** — you'll see runtime errors on startup. Upgrade to Node 24+ and re-run `ha --version`.
- **Anything else** — run `ha doctor --json` first; it usually points straight at the problem.

Next: **[Your first loop](02-first-loop.md)**
