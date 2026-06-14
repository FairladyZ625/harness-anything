# M2.5 Runtime And Release Readiness

Status: source checkout and package smoke only. Runtime checks are executable;
desktop release artifacts remain future work.

## Runtime Contract

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

## Package Smoke

The package smoke validates the current package artifact path without claiming a
published npm release:

```bash
npm run harness:smoke-cli-package
```

The smoke builds and packs the CLI workspace, installs the tarball in a temporary
consumer project, and exercises JSON CLI commands.

## GUI Build

The GUI renderer build is checked independently from desktop packaging:

```bash
npm run -w @harness-anything/gui build
```

This proves the renderer bundle compiles. It is not a signed desktop installer,
notarized build, or release artifact.

## Release Boundary

Current release boundaries are intentionally conservative:

- Packages remain private and at version `0.0.0`.
- No npm package release is claimed.
- signed installers, notarized builds, auto-update, release feeds, and published
  artifacts are not shipped.
- Desktop and daemon distribution policy remains governed by
  `docs-release/m2-5-gui-distribution.md`.

Future release tasks must extend the executable runtime/release readiness
contract instead of relying on prose-only release notes.
