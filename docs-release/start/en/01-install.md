# Install

The CLI and daemon are published npm packages for Node.js 24 or newer. The desktop App is downloaded from the [GitHub Releases page](https://github.com/FairladyZ625/harness-anything/releases).

## Install CLI and daemon

```bash
npm install --global @harness-anything/cli@latest @harness-anything/daemon@latest
ha --version
```

Preview releases use the `next` channel:

```bash
npm install --global @harness-anything/cli@next @harness-anything/daemon@next
```

## Install the desktop App

Download the asset matching the npm version from [GitHub Releases](https://github.com/FairladyZ625/harness-anything/releases).
macOS is Apple Silicon arm64 only (dmg/zip); Windows is x64 NSIS and may show SmartScreen; Linux is x64 AppImage or deb.
AppImage receives automatic updates; deb users update manually.

## Requirements

- Node.js 24 or newer and npm.
- `git`.
- An existing git repository you can initialize or one already registered with the local daemon.

## Complete first run

`ha init` derives the repository id from the current directory and the owner identity from `git config user.name`.
Harness Anything writes daemon state under `~/.harness` by default and keeps repository ledgers in the selected repository.

## Uninstall

Run `npm uninstall --global @harness-anything/cli @harness-anything/daemon`. Remove `~/.harness` only if you intentionally want to delete daemon registry and cache state.
