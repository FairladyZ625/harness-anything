# M2.5 Product Line Map

Status: public product-line map for the M2.5 foundation. This page describes
what is shipped, what is foundation-only, and what remains planned.

## Status taxonomy

- Shipped: usable from this repository through public code, tests, and `npm run check`.
- Foundation: public contract, model, or gate exists, but the end-user product
  capability is not shipped yet.
- Planned: owned by a later milestone or task packet.

## Current product line

| Area | Status | Public entry point | Boundary |
| --- | --- | --- | --- |
| M1 minimal loop | Shipped | `docs-release/m1-minimal-loop.md` | Local task packages, generated cache checks, and post-merge governance loop. |
| M2 coding vertical | Shipped | `docs-release/m2-coding-vertical.md` | Coding vertical and preset command surface are usable from source; package publication is still deferred. |
| M2.5 CLI dogfood and Legacy Intake | Foundation | `docs-release/harness-agent-skill.md` | Local workflow is usable, but remaining template/preset parity work is tracked separately before full self-host migration. |
| M2.5 GUI/daemon foundation | Foundation | `docs-release/m2-5-gui-distribution.md` | GUI workspace, daemon API, terminal, remote tunnel, and distribution policies are public contracts/foundation slices, not a complete GUI product. |
| M2.5 runtime/release readiness | Foundation | `docs-release/m2-5-runtime-release.md` | Source checkout, Node 24/26 CI, GUI build, and CLI package smoke are executable gates; release artifacts remain unshipped. |
| M3-M7 | Planned | Roadmap status only | Task hierarchy, external adapters, cross-harness product line, full GUI product, and release hardening remain future work. |

## M2.5 GUI/daemon foundation

The GUI/daemon track now has public foundation slices for:

- daemon API contract registry and service mappability;
- terminal session metadata and durable backend policy;
- remote daemon tunnel control-plane policy;
- workspace shell pane model;
- distribution/update policy for desktop app, local daemon, and remote daemon.

These slices are not a claim that signed installers, auto-update, cloud relay, or
a finished GUI product are available. They are the implementation boundary that
later packaging, security, and product tasks must reuse.

## Next milestone ownership

| Milestone | Owns | Must not inherit as accidental state |
| --- | --- | --- |
| M3 | Task hierarchy and relation semantics | Workspace pane state or terminal session state as lifecycle truth. |
| M4 | External adapter implementation | Placeholder GitHub Issues or Linear packages as shipped integrations. |
| M5 | Cross-harness product-line identity | Cloud database or relay assumptions from local GUI work. |
| M6 | Full GUI product surface | Page-only GUI assumptions or duplicate CLI/daemon business logic. |
| M7 | Release hardening | Unsigned production, unreviewed license/SBOM gaps, or auto-update without signing/update-feed tests. |

## Public documentation map

- [M1 minimal loop](./m1-minimal-loop.md): repository model, local task state, and post-merge check loop.
- [M2 coding vertical](./m2-coding-vertical.md): coding vertical command flow, doctor, task completion, and Legacy Intake commands.
- [Harness agent skill](./harness-agent-skill.md): concise operating rules for agents using the current harness surface.
- [M2.5 GUI distribution and update](./m2-5-gui-distribution.md): distribution/update policy boundaries for desktop app and daemon work.
- [M2.5 runtime and release readiness](./m2-5-runtime-release.md): source runtime, Node 24/26 CI, package smoke, and non-shipped release boundary.

## Release boundary

Packages remain private and versions remain `0.0.0`. The public gate for this
repository is still:

```bash
npm run check
```
