# M2.5 Supply Chain And License Gate

Status: release gate only. Supply-chain and license checks are executable, but
release artifacts are not published.

## Default Local Gate

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

## OSV Readiness

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

## License Policy

Harness Anything remains licensed as AGPL-3.0-or-later. The supply-chain gate
checks the root package, every workspace package, lockfile dependency license
metadata, and SBOM component licenses against the current release policy.

Allowed dependency license identifiers are intentionally narrow for M2.5:
`0BSD`, `Apache-2.0`, `BlueOak-1.0.0`, `BSD-2-Clause`, `BSD-3-Clause`,
`ISC`, `MIT`, and `MPL-2.0`.

## AGPL network-service release note checklist

Future hosted or network-service release packets must explicitly confirm:

- [ ] public source offer and license notice
- [ ] modified source corresponding to the network service
- [ ] deployment and service docs preserve AGPL notices
- [ ] release notes identify user-visible network-service changes
- [ ] third-party license notices included with release evidence

## Release Artifact SBOM Boundary

A release artifact SBOM is required before future desktop, daemon, installer, or
published package artifacts can be distributed. M2.5 does not publish those
artifacts, so this page defines the gate rather than providing artifact SBOMs.

## Dependabot And Electron Upgrades

Dependabot must cover the root npm workspace and the GUI workspace. Electron
upgrades require security review because they can change sandbox, renderer,
permission, navigation, and IPC assumptions.

Electron upgrades require security review before merge.
