# @harness-anything/gui

Harness Anything GUI foundation package.

This package is the local desktop controller surface for KR-09. It defines the
Electron window security contract, preload API allowlist, localhost API guards,
renderer view model, document sanitization, and shell panel boundary.

The GUI is not an agent runtime control plane. Shell output is display-only and
never becomes task state implicitly.

Electron Harness client package. GUI and CLI share the same Controller/Service
layer; GUI does not parse or control agent runtime sessions.

## Distribution Status

Version 0.0.1 is the macOS Local v1 release candidate. The Apple-silicon DMG
bundles the GUI, Node 24 runtime, CLI, and local daemon, and its first-run wizard
bootstraps a selected git repository. It is deliberately unsigned and
unnotarized; signing, notarization, and auto-update are not shipped capabilities.

The policy separates:

- desktop app distribution for macOS, Windows, and Linux;
- local daemon install/update behavior across macOS, Windows, and Linux;
- remote daemon bootstrap/update over the existing system SSH tunnel and daemon
  API contract.

The unsigned candidate is installed manually with the documented macOS
right-click Open flow. It is not a claim of signed production distribution.
