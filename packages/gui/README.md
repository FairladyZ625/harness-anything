# @harness-anything/gui

Harness Anything GUI foundation package.

This package is the local desktop controller surface for KR-09. It defines the
Electron window security contract, preload API allowlist, localhost API guards,
renderer view model, document sanitization, and shell panel boundary.

The GUI is not an agent runtime control plane. Shell output is display-only and
never becomes task state implicitly.

Electron Harness client package. GUI and CLI share the same Controller/Service
layer; GUI does not parse or control agent runtime sessions.

## Launch

Run `ha gui` from the repository to open, or pass `ha gui --root <path>`. This
is the only production launch entry: the CLI builds the renderer and preload,
acquires the default daemon through its canonical autostart path, and detaches
Electron. The Electron process is attach-only; it never starts, restarts, or
stops the daemon.

`npm run dev:electron` remains package-local for contributor hot reload. It
does not fast-forward Git and is not a production entry.

## Distribution Status

Version 0.0.1 retains packaging checks for the macOS Local candidate, but the
unsigned DMG is not a supported launch surface. Signing, notarization,
auto-update, and direct packaged-app launch remain unshipped capabilities.

The policy separates:

- desktop app distribution for macOS, Windows, and Linux;
- local daemon install/update behavior across macOS, Windows, and Linux;
- remote daemon bootstrap/update over the existing system SSH tunnel and daemon
  API contract.

The unsigned candidate is installed manually with the documented macOS
right-click Open flow. It is not a claim of signed production distribution.
