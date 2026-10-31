# Install

The CLI and daemon require Node.js 24 or newer. They are not currently published to the public npm registry; use the [source checkout smoke demo](00-what-is-this.md) until publication. The desktop App is downloaded from the [GitHub Releases page](https://github.com/FairladyZ625/harness-anything/releases).

## CLI and daemon

The source checkout path builds the CLI locally and runs it from that checkout. It does not install a global `ha` command.

## Install the desktop App

Download the asset matching the npm version from [GitHub Releases](https://github.com/FairladyZ625/harness-anything/releases).
macOS is Apple Silicon arm64 only (dmg/zip); Windows is x64 NSIS and may show SmartScreen; Linux is x64 AppImage or deb.
AppImage receives automatic updates; deb users update manually.

## Requirements

- Node.js 24 or newer and npm.
- `git`.
- An existing git repository you can initialize or one already registered with the local daemon.
- A configured authorization authority and signed-in user before repository initialization; see [Server Daemon Operations](../../operations-server-daemon.md).

## Complete first run

`ha init` derives the repository id from the current directory and the owner identity from `git config user.name`.
Harness Anything writes daemon state under `~/.harness` by default and keeps repository ledgers in the selected repository.

## Uninstall

Remove the source checkout when you no longer need it. Daemon state under `~/.harness` is separate; remove it only if you intentionally want to delete the registry and cache.
