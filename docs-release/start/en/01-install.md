# Install

Version 0.0.1 is the first macOS Local release candidate. It runs the desktop
app and daemon on your Mac; it does not require a Harness Anything server or a
source checkout.

## macOS requirements

- Apple silicon Mac (arm64), macOS 12 or newer.
- `git`. Run `git --version`; if macOS prompts for Command Line Tools, install
  them before first launch.
- An existing git repository you can initialize during the first-run wizard.

The desktop app bundles its own Node.js runtime. Node.js 24 is required only
when installing the separate npm CLI.

## Install the DMG from GitHub Releases

1. Download `Harness-Anything-0.0.1-arm64.dmg` and
   `SHA256SUMS-macos-arm64.txt` from the `gui-v0.0.1` GitHub Release.
2. Verify the checksum:

   ```bash
   shasum -a 256 Harness-Anything-0.0.1-arm64.dmg
   ```

3. Open the DMG and drag **Harness Anything** into **Applications**.
4. Because 0.0.1 is intentionally unsigned and unnotarized, do not double-click
   it on first launch. In Finder, open Applications, Control-click or
   right-click **Harness Anything**, choose **Open**, then choose **Open** again.
5. If macOS still blocks it, open **System Settings → Privacy & Security**, find
   the blocked Harness Anything message, choose **Open Anyway**, authenticate,
   and confirm **Open**.

Only use the GitHub Release or the documented Homebrew tap. Do not remove the
quarantine attribute from an app obtained from an unknown source.

## Complete first run

The first-run wizard uses three steps:

1. Choose your git repository, set its repository id, and enter the owner
   identity that will be recorded in the local ledger. Select **Initialize
   repository**. This creates `harness/`, registers the repository, and starts
   the bundled local daemon.
2. In **Provider**, add a detected Claude, Codex, or AGY installation and choose
   its model. You may continue and configure it later.
3. In **Agent · Squad**, create an Agent declaration and set its runtime
   preferences. Choose **Finish setup** when the GUI is ready for normal use.

Harness Anything writes daemon state under `~/.harness` by default. Repository
ledger files stay in the selected repository. No application server is used.

## Install with Homebrew

The in-repository cask is `packaging/homebrew/harness-anything.rb`. After the
tap repository is published, install it with:

```bash
brew tap FairladyZ625/harness-anything
brew install --cask harness-anything
```

To publish or test the cask from this checkout:

```bash
brew tap-new FairladyZ625/harness-anything
cp packaging/homebrew/harness-anything.rb \
  "$(brew --repository FairladyZ625/harness-anything)/Casks/harness-anything.rb"
brew install --cask --no-quarantine harness-anything
```

`--no-quarantine` is limited to local cask validation. Normal users should keep
Gatekeeper enabled and use the right-click → Open flow above.

## Install the npm CLI

When published, the separate CLI package requires Node.js 24 or newer:

```bash
npm install --global @harness-anything/cli@0.0.1
ha --version
# 0.0.1
```

`ha` and `harness-anything` are aliases for the same command. Run
`ha capabilities --json` after installation to verify the CLI entry point.

## Source demo and release recording

Contributors can still run `npm run quickstart:demo`. Release maintainers can
prepare an isolated demo repository and start the macOS recording flow with:

```bash
npm run release:demo:record
```

## Uninstall

Quit Harness Anything, move `/Applications/Harness Anything.app` to Trash (or
run `brew uninstall --cask harness-anything`), then remove `~/.harness` only if
you intentionally want to delete local daemon registry and cache state. The
selected repository's `harness/` ledger is not removed automatically.

## Troubleshooting

- **“App is damaged” or cannot be opened** — download the DMG again from the
  GitHub Release, verify SHA-256, then use right-click → Open.
- **Daemon unavailable** — quit and reopen the app. If it persists, inspect
  `~/.harness/logs/` and include the log excerpt in a bug report.
- **Provider not detected** — install its CLI, ensure it is on your shell PATH,
  then reopen Provider and refresh discovery.
- **`ha: command not found`** — reinstall the npm CLI and ensure npm's global bin
  directory is on PATH.

Next: **[Your first loop](02-first-loop.md)**
