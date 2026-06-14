# M2.5 GUI Distribution And Update

Status: architecture contract only. Signed desktop installers and auto-update
remain unshipped M2.5 boundaries.

## Current State

Harness Anything GUI is validated from source and package smoke tests. Desktop
installers, daemon installers, signing, notarization, and update feeds are future
release implementation tasks.

## Distribution Surfaces

- Desktop app: macOS, Windows, and Linux must be modeled separately.
- Local daemon: may be bundled or installed as a sidecar, but its update policy
  remains distinct from renderer/workspace behavior and must cover macOS,
  Windows, and Linux separately.
- Remote daemon: installs only the headless daemon and uses system SSH tunnel
  bootstrap with the existing daemon API contract. It does not install the GUI on
  the remote host.

## Update Policy

M2.5 permits manual update planning only. Auto-update requires a later
implementation packet with signing, update feed, rollback, and security tests.

Unsigned artifacts are development-only. Production distribution requires
platform signing policy, and macOS production distribution requires notarization
policy.

## Implementation Interfaces

The executable policy lives in `@harness-anything/gui` as
`harnessDistributionPolicy` and `validateDistributionPolicy`. Future packaging
tasks should extend that contract instead of introducing a second release model.
