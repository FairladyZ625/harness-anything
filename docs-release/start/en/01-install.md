# Install

## Prerequisites

- **Node.js 24 or newer.** The CLI is tested on Node 24 and 26.
- **git.** Harness Anything writes into a git repository and uses it as the source of truth.

Check your Node version:

```bash
node --version   # must be >= 24
```

## Fastest path: run the smoke demo

There is no public npm package yet. The fastest honest path today is to clone
the source checkout and run the quickstart smoke:

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run quickstart:demo
```

The demo builds the CLI, creates a temporary git workspace, runs `ha init`,
creates a task, records a fact, lists the fact back, and renders a relation
graph. It is the 30-second proof that the accountability loop is real.

If you want to see the fail-closed path, run the intentionally broken variant:

```bash
npm run quickstart:demo:fail-closed
```

That command exits non-zero when the fact-recording step cannot produce valid
evidence. The point is the same as the product: no evidence, no quiet success.

## Install the CLI locally

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

## Future npm path

After the 0.1 package publication to npm, first contact moves to:

```bash
npx harness-anything init
```

That command is forward-looking today. Until the package is published, use
`npm run quickstart:demo` for the fastest proof and `npm install -g ./packages/cli`
when you need `ha` on your PATH.

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
