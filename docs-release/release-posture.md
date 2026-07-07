# Release Posture

Status: single public anchor for release governance. This page merges the
runtime/release, supply-chain/license, and product-line posture that governs
what is shipped, what is foundation-only, and what remains planned. Executable
gates enforce it; release artifacts are not published.

## Status taxonomy

- Shipped: usable from this repository through public code, tests, and `npm run check`.
- Foundation: public contract, model, or gate exists, but the end-user product
  capability is not shipped yet.
- Planned: owned by a later milestone or task packet.

## Product line status

| Area | Status | Boundary |
| --- | --- | --- |
| Minimal loop | Shipped | Local task packages, generated cache checks, and post-merge governance loop. |
| Coding vertical | Shipped | Coding vertical and preset command surface are usable from source; package publication is still deferred. |
| CLI dogfood and Legacy Intake | Foundation | Local workflow is usable, but remaining template/preset parity work is tracked separately before full self-host migration. |
| M2.5 GUI/daemon foundation | Foundation | GUI workspace, daemon API, terminal, remote tunnel, and distribution policies are public contracts/foundation slices, not a complete GUI product. |
| Runtime/release readiness | Foundation | Source checkout, Node 24/26 CI, GUI build, and CLI package smoke are executable gates; release artifacts remain unshipped. |
| Supply-chain/license gate | Foundation | npm audit, SBOM, OSV readiness, license policy, Dependabot coverage, and AGPL release-note checklist are executable or packet-checkable gates; release artifacts remain unshipped. |
| M3-M7 | Planned | Task hierarchy, external adapters, cross-harness product line, full GUI product, and release hardening remain future work. |

### M2.5 GUI/daemon foundation

The GUI/daemon track has public foundation slices for:

- daemon API contract registry and service mappability;
- terminal session metadata and durable backend policy;
- remote daemon tunnel control-plane policy;
- workspace shell pane model;
- distribution/update policy for desktop app, local daemon, and remote daemon.

These slices are not a claim that signed installers, auto-update, cloud relay, or
a finished GUI product are available. They are the implementation boundary that
later packaging, security, and product tasks must reuse.

### Next milestone ownership

| Milestone | Owns | Must not inherit as accidental state |
| --- | --- | --- |
| M3 | Task hierarchy and relation semantics | Workspace pane state or terminal session state as lifecycle truth. |
| M4 | External adapter implementation | Placeholder GitHub Issues or Linear packages as shipped integrations. |
| M5 | Cross-harness product-line identity | Cloud database or relay assumptions from local GUI work. |
| M6 | Full GUI product surface | Page-only GUI assumptions or duplicate CLI/daemon business logic. |
| M7 | Release hardening | Unsigned production, unreviewed license/SBOM gaps, or auto-update without signing/update-feed tests. |

## Runtime and release readiness

Status: source checkout and package smoke only. Runtime checks are executable;
desktop release artifacts remain future work.

### Runtime contract

Harness Anything runs from source on Node 24 or newer. The public CI matrix
covers Node 24 and Node 26 so source-entry commands, typecheck, and tests stay
aligned with the documented runtime.

Use the source CLI entrypoint for the smallest runtime smoke:

```bash
node packages/cli/src/index.ts --json doctor
```

Use the full local readiness gate before public commits:

```bash
npm ci
npm run check
```

For PR-sized local feedback, run the tiered gate:

```bash
npm run check:pr
```

### Package smoke

The package smoke validates the current package artifact path without claiming a
published npm release:

```bash
npm run harness:smoke-cli-package
```

The smoke builds and packs the CLI workspace, installs the tarball in a temporary
consumer project, and exercises JSON CLI commands.

### GUI build

The GUI renderer build is checked independently from desktop packaging:

```bash
npm run -w @harness-anything/gui build
```

This proves the renderer bundle compiles. It is not a signed desktop installer,
notarized build, or release artifact.

### GUI distribution and update boundary

Harness Anything GUI is validated from source and package smoke tests. Desktop
installers, daemon installers, signing, notarization, and update feeds are future
release implementation tasks. Desktop app, local daemon, and remote daemon must
be modeled separately, and M2.5 permits manual update planning only: auto-update
requires a later implementation packet with signing, update feed, rollback, and
security tests. Unsigned artifacts are development-only.

### Runtime release boundary

Current release boundaries are intentionally conservative:

- Only `@harness-anything/cli` is public-ready for npm publish dry-run preflight at version `0.1.0`.
- All non-CLI workspace packages remain private and at version `0.0.0`.
- No real npm package release is claimed.
- signed installers, notarized builds, auto-update, release feeds, and published
  artifacts are not shipped.
- Desktop and daemon distribution policy is governed by this page.

Future release tasks must extend the executable runtime/release readiness
contract instead of relying on prose-only release notes.

## Supply chain and license gate

Status: release gate only. Supply-chain and license checks are executable, but
release artifacts are not published.

### Default local gate

The default gate is deterministic enough for local and CI use:

```bash
npm run harness:check-supply-chain
```

It runs both high-severity npm audit paths:

```bash
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
```

It also validates CycloneDX SBOM output from:

```bash
npm sbom --sbom-format=cyclonedx --sbom-type=application
```

The SBOM check requires package URLs, hashes, and license metadata for dependency
components.

### npm publish dry-run

The only npm publish preflight command allowed in this phase is:

```bash
npm publish --dry-run --workspace @harness-anything/cli --access public
```

This command is dry-run only. It may build and inspect the CLI package artifact,
but it must not be replaced by a real `npm publish` command in this task phase.

### OSV readiness

OSV readiness is part of the release evidence path, but the live OSV scan is not
part of the default local gate because it depends on an external service. Future
release packets must run and attach evidence from:

```bash
npx --yes osv-scanner@latest --lockfile=package-lock.json
```

The expected release evidence path is:

```text
release-evidence/osv/scan-result.json
```

The default gate still checks that `package-lock.json` exists and that this live
scan command and evidence path remain documented.

### License policy

Harness Anything remains licensed as AGPL-3.0-or-later. The supply-chain gate
checks the root package, every workspace package, lockfile dependency license
metadata, and SBOM component licenses against the current release policy.

Allowed dependency license identifiers are intentionally narrow for M2.5:
`0BSD`, `Apache-2.0`, `BlueOak-1.0.0`, `BSD-2-Clause`, `BSD-3-Clause`,
`ISC`, `MIT`, and `MPL-2.0`.

### AGPL network-service release note checklist

Future hosted or network-service release packets must explicitly confirm:

- [ ] public source offer and license notice
- [ ] modified source corresponding to the network service
- [ ] deployment and service docs preserve AGPL notices
- [ ] release notes identify user-visible network-service changes
- [ ] third-party license notices included with release evidence

### Release artifact SBOM boundary

A release artifact SBOM is required before future desktop, daemon, installer, or
published package artifacts can be distributed. M2.5 does not publish those
artifacts, so this page defines the gate rather than providing artifact SBOMs.

### Dependabot and Electron upgrades

Dependabot must cover the root npm workspace and the GUI workspace. Electron
upgrades require security review because they can change sandbox, renderer,
permission, navigation, and IPC assumptions.

Electron upgrades require security review before merge.
