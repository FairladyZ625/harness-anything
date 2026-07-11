# Release Posture

Status: single public anchor for release governance. This page is the authority
for what is shipped, what is implemented but not yet productized, what is only a
foundation slice, what is experimental, and what remains planned. Other public
docs should link here instead of restating status tables.

## Status taxonomy

- Shipped: usable from this repository through documented or discoverable public
  command surfaces, with implementation evidence and tests or gates behind it.
- Mechanism-complete: the implementation path or gate exists in code, but the
  user-facing workflow still lacks product documentation, usage proof, cleanup,
  or release evidence. Treat it as real mechanism, not as a polished product.
- Foundation: a public contract, model, build, policy, or guardrail exists, but
  the end-user capability is not shipped yet.
- Experimental: a narrow prototype or shim exists for one topology or session
  shape, with known limits that prevent a general support claim.
- Planned: not implemented as a supported capability, or explicitly owned by a
  later milestone or task packet.

## Capability status

| Area                                              | Status       | Boundary and evidence                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source CLI write path                             | Shipped      | CLI write commands require explicit actor attribution and a git author. `HARNESS_ACTOR` remains for `agent:<id>` and `system:<id>`; human writes must use `--actor human:<id>` because environments are inherited. The journal records `env`, `flag`, or `daemon` source. Examples use `HARNESS_GIT_AUTHOR_NAME` / `HARNESS_GIT_AUTHOR_EMAIL`, with Git author variable fallbacks. Evidence: `packages/cli/src/composition/actor-attribution.ts`. |
| Task hierarchy and relation semantics             | Shipped      | `ha task create --parent <id>`, `ha task tree <id> [--json]`, and `ha task relate <src> depends-on <tgt> --rationale <t>` exist, with depends-on cycle detection. Completing a parent does not require completing children; it emits the `open_child_tasks` warning. The `parent` field is immutable after creation. Evidence: canon 1.4.                                                                                                         |
| Local daemon, including single-machine multi-repo | Shipped      | `ha daemon start`, `ha daemon repo register`, hot registration reconciliation, and repo-scoped CLI routing work for local daemon mode. CLI defaults to direct in-process execution unless `HARNESS_DAEMON_MODE=local` is set. Evidence: canon 1.3.                                                                                                                                                                                                |
| Desktop GUI source surface                        | Foundation   | The GUI can be built and run from source and can read real ledger data for several views, but status changes, review, progress append, archive, decision adjudication, terminal, presets, adapters, and parts of relations are either state-only, read-only, deferred, or mock-backed. The repository declares this as `source-checkout-and-package-smoke-only`. Evidence: canon 1.2.                                                             |
| Remote SSH daemon mode                            | Experimental | Remote mode opens `ssh <host> ha daemon connect --stdio` to an existing daemon. Team principals require per-key `authorized_keys` forced commands and roster credentials; the relay verifies the sshd process context, exact original command, and pinned root. It is not GUI-to-remote-daemon, a tunnel product, TCP, HTTP, or WebSocket. Evidence: `packages/cli/src/commands/daemon/connect.ts`.                                               |
| Runtime/release readiness                         | Foundation   | Source checkout, Node 24 and Node 26 CI, package smoke, and GUI build checks are executable gates. Release artifacts remain unshipped. Evidence: `packages/gui/src/distribution/runtime-release-readiness.ts:50-60` and canon 1.2.                                                                                                                                                                                                                |
| Supply-chain/license gate                         | Foundation   | npm audit, SBOM validation, OSV evidence path checks, license policy, Dependabot coverage, and AGPL network-service release-note checklist are gates or packet-checkable policy. Release artifacts remain unshipped. Evidence: `package.json:71` and `tools/check-supply-chain.mjs:51-74`.                                                                                                                                                        |
| M3-M7 backlog                                     | Planned      | External adapter implementations, full GUI product behavior, and release hardening are not shipped. Placeholder adapter packages, page-only GUI code, unsigned artifacts, and release-policy prose must not be inherited as shipped product state.                                                                                                                                                                                                |

## Mechanism-complete ledger

These mechanisms are implemented enough to be real, but this page does not treat
them as polished product surface until the missing documentation, evidence, or
workflow work is closed.

| Capability                   | Status             | Boundary and evidence                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtask expansion preset     | Mechanism-complete | `ha preset action subtask-expansion plan --task <id> --allow-scripts` produces a `subtask-plan/v1` artifact and command strings. It is a planner, not an automatic expander; a user must execute the generated task-create commands. Evidence: canon 1.4. |
| Decision-document CAS writes | Mechanism-complete | Decision document writes use optimistic concurrency and can return `cas_watermark_mismatch`, surfaced through the CLI as `write_rejected`. Evidence: canon 1.4.                                                                                           |
| Append-delta idempotency     | Mechanism-complete | Byte-identical duplicate fact records are now idempotent no-ops instead of rejections. Evidence: canon 1.4.                                                                                                                                               |
| Claim-check blob store       | Mechanism-complete | Session bodies can be stored as content-addressed blobs under `harness/objects/sha256/...`; v0 has no garbage collection or chunking. Evidence: canon 1.4.                                                                                                |
| Code-doc reconciliation gate | Mechanism-complete | When the resolved preset/profile declares `code-doc-reconciliation` (as bundled coding profiles do), `ha task complete` hard-fails unless hand-authored `harness/tasks/<id>/code-doc-anchors.json` exists; task creation does not generate it. The gate is contract-derived, not universal (ADR-0027 D7). Evidence: canon 1.4. |
| Distill loop                 | Mechanism-complete | `ha task complete` schedules distill candidates, and `ha distill candidate` / `ha distill promote` exist. Public release docs still need a real distill workflow. Evidence: canon 1.4.                                                                    |
| Create-milestone preset      | Mechanism-complete | `ha preset action create-milestone <scaffold                                                                                                                                                                                                              | render-html | check> --task <id> --allow-scripts --input ...`exists. There is no top-level`ha create-milestone` command. Evidence: canon 1.4. |
| Task archive                 | Shipped            | `ha task archive <id> --reason <r>` supports single and batch forms, including `--ids`, `--filter state:<s>`, and `--before`. Evidence: canon 1.4.                                                                                                        |
| Graph panorama flags         | Shipped            | `ha graph` supports `--out`, `--focus`, `--projection`, `--include-archived`, and `--json`; callers need the projection database precondition. Evidence: canon 1.4.                                                                                       |

## M2.5 GUI/daemon foundation

The GUI/daemon track has real foundation slices:

- local daemon reads and writes through the method registry;
- local daemon repo registration and multi-repo routing;
- GUI source checkout that reads real ledger data in the supported read paths;
- graph topology backed by real relation projection in graph-oriented views;
- build, runtime, and distribution policy checks for source checkout and package
  smoke.

The same track also has explicit non-capabilities:

- no signed installers, notarization, published release artifacts, or
  auto-update;
- no GUI task management write path;
- no GUI decision adjudication;
- no GUI connection to a daemon on another machine;
- no working remote tunnel, attach-token transport, TCP listener, HTTP API,
  WebSocket server, live notification subscription, or enforced RBAC when no
  `harness/people.yaml` roster exists.

These boundaries are why the GUI is foundation state, not a full desktop
product.

## Non-shipped boundary summary

| Surface                                     | Not shipped yet                                                                                                                    | Must not inherit as accidental state                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Shipped and mechanism-complete CLI surfaces | Workflow proof and complete public documentation.                                                                                  | Old docs that call shipped hierarchy work planned, or docs that hide attribution requirements for write commands.             |
| Adapter integrations                        | Real GitHub Issues or Linear implementations and proof.                                                                            | Placeholder packages as shipped integrations.                                                                                 |
| Full GUI product                            | Persisted GUI writes, decision actions, real relations everywhere, non-mock terminal/adapters/presets, and supported distribution. | Page-only GUI assumptions, duplicate CLI/daemon business logic, or state-only drag/drop behavior as lifecycle truth.          |
| Release hardening                           | Signed artifacts, notarization, update feeds, release artifact SBOMs, and publication evidence.                                    | Unsigned production, unreviewed license/SBOM gaps, or auto-update without signing, update-feed, rollback, and security tests. |

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
be modeled separately, and the current policy permits manual update planning
only: auto-update requires a later implementation packet with signing, update
feed, rollback, and security tests. Unsigned artifacts are development-only.

### Runtime release boundary

Current release boundaries are intentionally conservative:

- Only `@harness-anything/cli` is public-ready for npm publish dry-run preflight
  at version `0.1.0`.
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

Allowed dependency license identifiers are intentionally narrow for this phase:
`0BSD`, `Apache-2.0`, `BlueOak-1.0.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`,
`MIT`, and `MPL-2.0`.

### AGPL network-service release note checklist

Future hosted or network-service release packets must explicitly confirm:

- [ ] public source offer and license notice
- [ ] modified source corresponding to the network service
- [ ] deployment and service docs preserve AGPL notices
- [ ] release notes identify user-visible network-service changes
- [ ] third-party license notices included with release evidence

### Release artifact SBOM boundary

A release artifact SBOM is required before future desktop, daemon, installer, or
published package artifacts can be distributed. The current phase does not
publish those artifacts, so this page defines the gate rather than providing
artifact SBOMs.

### Dependabot and Electron upgrades

Dependabot must cover the root npm workspace and the GUI workspace. Electron
upgrades require security review because they can change sandbox, renderer,
permission, navigation, and IPC assumptions.

Electron upgrades require security review before merge.
