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

Current status is source checkout plus package smoke validation only. The GUI
package defines a distribution/update policy contract for future desktop and
daemon release work, but signed installers, notarized builds, and auto-update
are not shipped capabilities yet.

The policy separates:

- desktop app distribution for macOS, Windows, and Linux;
- local daemon install/update behavior across macOS, Windows, and Linux;
- remote daemon bootstrap/update over the existing system SSH tunnel and daemon
  API contract.

Unsigned artifacts are development-only. Production desktop or daemon
distribution must define platform signing policy first, and macOS production
distribution must include notarization policy.

## Installation and project selection contract

The desktop artifact is the complete machine-level product: it carries the GUI,
CLI distribution, daemon runtime dependencies, and a bundled Node runtime. A
target Harness project does not install Electron or `@harness-anything/gui`.

`ha gui` always separates two inputs:

- the trusted installed product or verified source checkout that supplies the
  GUI executable;
- the caller's current Harness root, supplied to the GUI as
  `HARNESS_GUI_ROOT`.

This permits one installation to open any number of initialized Harness
projects without using those projects as npm workspaces. The current release
boundary remains unchanged: local unsigned packaging is development-only, and
signed/notarized public installers are not yet shipped.
