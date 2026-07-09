<div align="center">

# Harness Anything

**Your agent says it's done. Make it prove it.**

Harness Anything is the accountability layer for AI agents: every decision,
task, and fact your agent produces becomes auditable structure on git, and
*"done"* has to get past a gate, with evidence.

<p>
  <a href="#quickstart">Quickstart</a> |
  <a href="#what-you-get">What you get</a> |
  <a href="#documentation">Docs</a> |
  <a href="#under-the-hood">Under the hood</a> |
  <a href="./CHANGELOG.md">Changelog</a>
</p>

<p>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/FairladyZ625/harness-anything?style=flat&logo=github&color=yellow"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-brightgreen">
  <a href="./LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20%26%20unstable-orange">
</p>

<p>
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="Simplified Chinese README" src="https://img.shields.io/badge/Chinese-d9d9d9"></a>
</p>

</div>

---

Agents are good at producing work and bad at staying accountable for it. They
forget context, reopen settled decisions, and declare victory before the record
can prove anything happened.

Harness Anything gives the agent a ledger it cannot hand-wave away. The work is
plain Markdown, the audit trail is git, and the exit path is gated: no evidence,
no real review, no CI result, no "done".

## Quickstart

Harness Anything currently runs from a source checkout, requires Node.js 24+,
and is still stabilizing its public command surface. The exact install and
first-loop commands live in the
[Start guide](./docs-release/start/en/00-what-is-this.md), which is the
maintained onboarding path.

After the first loop, you will have a private nested harness ledger for your
project. Code changes stay in your project repository; harness records are
committed inside the ledger repository so task evidence does not leak into
ordinary code commits.

## What You Get

### A ledger with three primitives

- **Decision** records the choice: question, selected path, rejected
  alternatives, rationale, and arbiter. Decisions can be superseded, not erased.
- **Task** records the work: a task package with plan, progress, facts, review,
  and closeout. Lifecycle states are validated by the kernel, and terminal
  completion is gated.
- **Fact** records the evidence: append-only observations with source and
  confidence. Later facts can invalidate earlier ones without rewriting history.

### Task trees, not a flat todo list

Tasks can have create-time parents, can be rendered as a tree, and can carry
task-to-task `depends-on` relations. Parent bindings are checked for cycles, and
`depends-on` writes reject dependency cycles. A parent does not automatically
prove its children are closed; completion gates report open children as a
warning rather than pretending the whole tree is finished.

Evidence: parent parsing in `packages/cli/src/cli/parsers/new-task.ts`, tree
rendering in `packages/cli/src/commands/core/task-query.ts`, parent cycle
checks in `packages/adapters/local/src/task-index.ts`, immutable parent
contracts in `packages/kernel/src/entity/field-contracts.ts`, and dependency
cycle rejection in `packages/cli/src/commands/core/task-relations.ts`.

### A local daemon for multiple ledgers

The daemon is a local write coordinator. It can register multiple initialized
harness repositories, serve them from one user-level daemon, route CLI requests
by repo id, and attach newly registered repos while running. CLI direct mode
still exists; daemon-backed CLI use is opt-in.

The daemon is not an HTTP service, not a network API, and not a remote team
collaboration product. Authorization is only enforced when a repository has
`harness/people.yaml`; otherwise local daemon connections are trusted by the
local transport boundary.

Evidence: daemon start in `packages/cli/src/commands/daemon/productization.ts`,
repo registry in `packages/kernel/src/daemon/registry.ts`, multi-repo serving
and reconcile in `packages/cli/src/index.ts`, and repo namespace validation in
`packages/daemon/src/protocol/json-rpc-server.ts`.

### A read-only desktop panel over the real ledger

The Electron workspace can read real task, document, decision, fact, and
relation data through the local daemon bridge. The board, filters, favorites,
relation graph, fact triage, and copy-context surfaces are useful inspection
tools over that data.

It is not a released desktop app. There are no signed installers, notarized
builds, release feeds, or auto-update support. Do not rely on the GUI to manage
task lifecycle, write task state, or arbitrate decisions; write handlers exist
at the bridge boundary, but the shipped views are still read-oriented and some
surfaces remain mock-backed.

Evidence: renderer reads in `packages/gui/src/renderer/task-data.ts`, daemon
bridge routes in `packages/gui/src/api/service-bridge.ts`, client calls in
`packages/gui/src/renderer/api-client.ts`, read-only decision wiring in
`packages/gui/src/renderer/App.tsx`, runtime self-status in
`packages/gui/src/distribution/runtime-release-readiness.ts`, and unsigned
builder config in `packages/gui/electron-builder.config.mjs`.

### A hardened write path

Load-bearing writes now require explicit actor attribution. Decision snapshots
use optimistic concurrency checks, duplicate byte-identical fact appends are
idempotent, and large session bodies can be stored as content-addressed blobs
under the harness ledger.

Evidence: actor attribution in
`packages/cli/src/composition/actor-attribution.ts`, decision CAS checks in
`packages/kernel/src/store/write-journal-decision-documents.ts`, idempotent fact
append in `packages/kernel/src/store/write-journal-operations.ts`, and blob
storage in `packages/kernel/src/store/content-addressed-blob-store.ts`.

## Documentation

Three tracks, shallow to deep:

- [Start](./docs-release/start/en/00-what-is-this.md) - install, run one real loop, daily commands. ([Chinese](./docs-release/start/zh/00-what-is-this.md))
- [Learn](./docs-release/learn/en/00-overview.md) - the ideas: the three-primitive kernel, gates and fail-closed, the adoption law. ([Chinese](./docs-release/learn/zh/00-overview.md))
- [Architecture](./docs-release/architecture/en/00-overview.md) - the machine: storage model, write path, projection, gates in the pipeline. ([Chinese](./docs-release/architecture/zh/00-overview.md))

Also see [Release posture](./docs-release/release-posture.md), the single
public source for current product and release status, and the
[minimal example project](./examples/minimal-project/).

## Under The Hood

<details>
<summary><b>Architecture</b> - a small kernel, everything else consumes it</summary>

<br>

The kernel is the single semantic authority. It owns the domain model: the
three primitives, task identity, lifecycle vocabulary, schemas, projections,
relations, and storage ports. Lifecycle transitions are validated in one place;
edge layers consume those semantics instead of redefining them.

Everything around the kernel is a consumer. The CLI parses commands and renders
receipts, the application layer keeps orchestration out of UI and adapter code,
the daemon serializes local writes, and adapters collect or project evidence at
the boundary. Authored state is Markdown under git; generated state is a
rebuildable cache.

| Layer | What it does |
| --- | --- |
| **Kernel** | Primitives, domain types, lifecycle, schemas, relation projection, storage ports. |
| **CLI** | Local command surface for init, doctor, status, checks, tasks, decisions, facts, presets, modules, migration, evidence, and daemon routing. |
| **Application** | Shared controller/service orchestration used by CLI and GUI. |
| **Daemon** | Local multi-repo coordination, serialized writes, command events, repo routing. |
| **GUI** | Electron inspection surface and daemon bridge over real ledger reads; not a finished write product. |
| **Adapters** | External-system boundaries that do not own harness truth. |

</details>

<details>
<summary><b>Core concepts</b> - primitives, evidence, gates, lifecycle</summary>

<br>

- **Gate** - fail-closed checks on load-bearing writes: facts required,
  review verdicts schema-checked, closeout placeholders rejected, CI results
  demanded, and code-doc anchors checked during completion.
- **Vertical and preset** - a vertical, such as `software/coding`, defines the
  task domain and contracts; a preset adds workflow templates, checks, and
  actions on top.
- **Module** - a registered project slice that tasks can target, so
  multi-module work stays filterable and scoped.
- **Projection** - a SQLite read model derived from Markdown. If it is stale or
  missing, it can be rebuilt; the files remain the source of truth.

</details>

<details>
<summary><b>Packages</b> - the monorepo layout</summary>

<br>

One git monorepo. Packages under `packages/` are npm workspace packages. Nothing
is published to npm from this repository at this time.

| Package | Purpose |
| --- | --- |
| `@harness-anything/kernel` | Domain model, primitives, lifecycle, schemas, projections, storage ports. |
| `@harness-anything/cli` | Local command surface for project, task, decision, fact, preset, module, migration, evidence, daemon, and checks. |
| `@harness-anything/application` | Shared controller/service layer used by CLI and GUI. |
| `@harness-anything/daemon` | Local JSON-RPC daemon runtime, repo namespace routing, transport and identity boundaries. |
| `@harness-anything/gui` | Electron GUI foundation, daemon/API contracts, renderer boundary. |
| `@harness-anything/adapter-local` | Local adapter surface. |
| `@harness-anything/adapter-multica` | Multica issue snapshot/adopt surface. |
| `@harness-anything/adapter-github-issues` | Placeholder package for future GitHub Issues integration. |
| `@harness-anything/adapter-linear` | Placeholder package for future Linear integration. |

</details>

<details>
<summary><b>Release posture</b> - status pointer</summary>

<br>

[Shipped / Foundation / Planned status](./docs-release/release-posture.md) lives
in the release posture page, the single public source for runtime, packaging,
capability, supply-chain, and license status. This README intentionally does
not duplicate that status matrix.

</details>

<details>
<summary><b>Design principles</b> - the rules the checks enforce</summary>

<br>

- **The only path is the gated path.** Agents adopt whatever route exists; leave
  an ungated shortcut and it will be taken.
- **Semantics live in the kernel.** Edge layers consume the domain model; they
  never redefine lifecycle, identity, or validation.
- **Contracts derive from one canonical source.** Command receipts, API
  registries, and schemas align to a single authority; governance checks fail
  when a surface drifts.
- **Authored state is truth; generated state is a cache.** Markdown under git
  is canonical; the SQLite projection is rebuildable and verifiable.
- **Dormant code does not ship.** Placeholders stay named as placeholders, and
  release gates require evidence before publication.

</details>

## Contributing

The most useful contributions right now are sharp bug reports, failing test
cases, architecture questions, and small documentation fixes. Before opening a
pull request, run the local gate documented in the contributing guide.

Please keep public changes out of private harness state. Do not add
`.harness-private/`, root-local agent instructions, or private planning docs to
public commits. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[AGPL-3.0-or-later](./LICENSE). Harness Anything stays open, including when
someone offers it as a service.
