# Install

Harness Anything currently runs from a source checkout with Node.js 24 or newer. The supported desktop entry is
`ha gui`; launching a packaged Electron executable directly is not a supported production path.

## Requirements

- Node.js 24 or newer and npm.
- `git`.
- An existing git repository you can initialize or one already registered with the local daemon.

## Install the source CLI and GUI

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run build -w @harness-anything/cli
(cd packages/cli && npm link)
ha --version
```

The global link keeps `ha` anchored to this canonical checkout. Do not point it at a feature worktree: worktrees are
repository contexts, not daemon or GUI installation owners.

## Launch the Electron GUI

From the repository you want to open:

```bash
ha gui
```

Or select it explicitly from any directory:

```bash
ha gui --root /path/to/repository
```

`ha gui` rebuilds the renderer and preload from the canonical installation, obtains the default daemon through the
same canonical-only CLI autostart path used by other `ha` commands, and then launches Electron detached. The selected
directory only determines repository context. Closing Electron never stops the daemon, and an open GUI never restarts
a daemon that an operator stopped.

`npm run dev:electron` is a package-local hot-reload tool for GUI contributors. It is not a user launch command.

## Complete first run

The first-run wizard uses three steps:

1. Choose your git repository, set its repository id, and enter the owner identity recorded in the local ledger.
   Select **Initialize repository**. This creates `harness/` and registers the repository with the daemon that the CLI
   acquired before Electron started.
2. In **Provider**, add a detected Claude, Codex, or AGY installation and choose its model. You may continue and
   configure it later.
3. In **Agent · Squad**, create an Agent declaration and set its runtime preferences. Choose **Finish setup** when the
   GUI is ready for normal use.

Harness Anything writes daemon state under `~/.harness` by default. Repository ledger files stay in the selected
repository. No application server is used.

## Install the npm CLI without the GUI

When published, the standalone CLI package requires Node.js 24 or newer:

```bash
npm install --global @harness-anything/cli@0.0.1
ha --version
```

The standalone CLI package does not contain the source GUI workspace. Use the source installation above for `ha gui`.
`ha` and `harness-anything` are aliases for the same command.

## Source demo

```bash
npm run quickstart:demo
```

The demo creates a throwaway project and exercises the CLI lifecycle without changing your selected repository.

## Uninstall

Quit the GUI, run `npm unlink --global @harness-anything/cli` from `packages/cli`, and remove the source checkout when
you no longer need it. Remove `~/.harness` only if you intentionally want to delete daemon registry and cache state.
Repository `harness/` ledgers are not removed automatically.

## Troubleshooting

- **`ha: command not found`** — rerun `npm link` from `packages/cli` and confirm npm's global bin directory is on
  `PATH`.
- **GUI build failed** — run `npm ci` in the canonical checkout, then retry `ha gui`.
- **Daemon unavailable** — run `ha daemon status`. If an operator intentionally stopped it, close the old window and
  run `ha gui` again from an operator shell. The existing GUI will not respawn it.
- **Provider not detected** — install its CLI, ensure it is on your shell `PATH`, then refresh Provider discovery.

Next: **[Your first loop](02-first-loop.md)**
