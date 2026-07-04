<div align="center">

# Harness Anything

**The durable task layer for coding agents.**

Local markdown task packages, a lifecycle your agent can't fudge, and drift you
can actually detect — so long-horizon work survives session boundaries.

<p>
  <a href="#quickstart">Quickstart</a> ·
  <a href="#recipes">Recipes</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#under-the-hood">Under the hood</a>
</p>

<p>
  <a href="./LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/FairladyZ625/harness-anything?style=flat&logo=github&color=yellow"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-brightgreen">
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20%26%20unstable-orange">
</p>

<p>
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
</p>

</div>

---

```console
$ ha init
✓ harness ready  ·  tasks live in ./harness/planning/tasks/ as plain markdown

$ ha new-task --title "Add rate limiting to /api/upload" \
      --vertical software/coding --preset standard-task
✓ task_01JQ8F3K2M  ·  planned

$ ha status
  task_01JQ8F3K2M   planned     Add rate limiting to /api/upload
  task_01JQ2A9X7P   in_review   Refactor upload MIME sniffing
  task_01JP7Z0C4B   blocked     Migrate legacy job queue

# …the agent writes the code, opens a PR, CI goes green…

$ ha task-complete task_01JQ8F3K2M --ci passed --reviewer alex
✓ done  ·  review + CI evidence sealed to the task

$ ha check --post-merge
✓ lifecycle valid    ✓ evidence intact    ✓ local state matches repo
```

## Why

Your agent nailed the task an hour ago. Now the session's compacted, the plan is
three scrollbacks up, and *"what was I working on?"* is genuinely hard to answer.

- Why should an agent's task state live in a chat transcript?
- Why should *"is this actually done?"* mean re-reading the conversation?
- Why should splitting, resuming, or **proving** work take anything more than a file?

Coding agents are great at writing code. They're bad at remembering what they
were doing and worse at proving it. Harness Anything fixes the second half:
durable task packages on disk, a lifecycle that can't be hand-waved, and one
command that tells you whether your local state still matches the repo.

*Harness Anything manages its own development — the harness is its own first user.*

## Highlights

- **Local-first, markdown-native.** Your tasks are just files under Git — grep
  them, diff them, review them in a PR. No database to babysit, no lock-in.
- **A lifecycle the agent can't fudge.** Six states, validated in exactly one
  place. "Done" means reviewed, CI-passed, and evidenced — not "the agent said so."
- **Drift is detectable.** Every task carries typed evidence, and one command
  proves your local state hasn't quietly diverged from the repository.
- **Built to be built on.** A small kernel owns the rules; CLI, GUI, and
  adapters compose on top without ever redefining them.

## Quickstart

> **Not on npm yet.** Harness Anything runs from source while the CLI surface
> stabilizes. Requires **Node.js 24+**.

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run check   # typecheck, tests, governance + supply-chain gates
```

The CLI runs straight from source (Node's built-in TypeScript execution). The
examples in this README use `ha` for readability — alias it once:

```bash
alias ha="node $(pwd)/packages/cli/src/index.ts"
ha doctor --json    # sanity-check your environment
```

Then drive the minimal loop inside any project:

```bash
ha --root /path/to/project init             # scaffold ./harness
ha --root /path/to/project new-task --title "First task"
ha --root /path/to/project status
ha --root /path/to/project check --post-merge
```

That's it — you now have durable, inspectable task state that any agent (or
human) can pick up cold.

## Recipes

```bash
# Start a task in the coding vertical, with a preset workflow
ha new-task --title "Implement slice" --vertical software/coding --preset standard-task

# Move a task's state, on the record
ha task status set task_01JQ8F3K2M active --reason "picked up"

# Close it through the review + CI gate
ha task-complete task_01JQ8F3K2M --ci passed --reviewer alex

# Capture a Git diff as evidence against a base ref
ha git-diff --base origin/main --json

# Rebuild an unfinished old task into a fresh one, with provenance
ha new-task --from-legacy <legacy-id>

# Prove local state still matches the repo
ha check --post-merge --json
```

The CLI (`harness-anything`, alias `ha`) exposes 50+ commands across project
setup, task creation, lifecycle, review/CI gates, migration intake, evidence,
and an extension surface. The daily command reference lives in the
[Start guide](./docs-release/start/en/03-daily-commands.md).

## Documentation

- [Start guide](./docs-release/start/en/00-what-is-this.md) — install, first loop, and daily commands ([中文](./docs-release/start/zh/00-what-is-this.md))
- [Learn guide](./docs-release/learn/en/00-overview.md) — the kernel, decisions, gates, verticals, and roadmap ([中文](./docs-release/learn/zh/00-overview.md))
- [Release posture](./docs-release/release-posture.md) — runtime/release, supply-chain & license, and product-line status
- [Minimal example project](./examples/minimal-project/)

## Under the hood

<details>
<summary><b>Architecture</b> — a small kernel, everything else consumes it</summary>

<br>

The kernel is the single semantic authority. It owns the domain model — task
identity, the six-state lifecycle, external bindings, package disposition,
closeout readiness — plus the schemas and storage ports everything else
consumes. Lifecycle transitions are validated in exactly one place; no edge
layer gets to redefine what "done" means.

Everything around the kernel is a consumer. The CLI parses commands and renders
receipts, the GUI foundation maps daemon and API contracts, the application
layer keeps orchestration out of UI code, and adapters collect or publish
evidence at the boundary. Contracts — command receipts, API registries, schemas
— derive from one canonical source rather than being re-declared per surface.

Authored state is plain markdown under Git; generated state is a rebuildable
cache. The markdown task package is the truth, a SQLite projection is derived
from it, and checks can always prove whether the two agree.

| Layer | What it does |
| --- | --- |
| **Kernel** | Domain types, six-state lifecycle, schemas, task projection, lifecycle validation, storage ports. |
| **CLI** | Local commands for init, doctor, status, checks, tasks, presets, modules, migration, and Git diff evidence. |
| **Application** | Keeps controller/service orchestration out of UI and adapter code. |
| **GUI foundation** | Electron shell, daemon/API contracts, session policies, distribution/update boundary. Foundation, not a finished product. |
| **Adapters** | Connect external systems without owning harness state. |

</details>

<details>
<summary><b>Core concepts</b> — task package, evidence, binding, lifecycle</summary>

<br>

- **Task package** — a markdown package under `harness/planning/tasks/` with a
  random `task_<ULID>` identity. It's the source of truth for one unit of work;
  slugs and titles are display metadata, not identity.
- **Evidence** — typed pointers (`type:path:summary`) attached to progress,
  review, and completion, plus dedicated evidence for Git diffs and legacy
  migration. Evidence is recorded, not inferred.
- **Binding** — a fingerprinted link between a task and an external engine
  reference. Core fields are immutable after creation, so tampering is detectable.
- **Lifecycle** — six states: `planned`, `active`, `blocked`, `in_review`,
  `done`, `cancelled`. `done` and `cancelled` are terminal; follow-up work uses
  supersede, not reopen. Archive and tombstone are dispositions, not states.
- **Vertical & preset** — a vertical (like `software/coding`) defines the task
  domain and its contracts; a preset (like `standard-task`) layers workflow
  choices — templates, checks, actions — on top.
- **Module** — a registered slice of the project that tasks can target, so
  multi-module work stays filterable and scoped.

</details>

<details>
<summary><b>Packages</b> — the monorepo layout</summary>

<br>

One Git monorepo. Packages under `packages/` are npm workspace packages (not
nested repos), all `private: true` at version `0.0.0` — nothing is published to
npm yet.

| Package | Purpose |
| --- | --- |
| `@harness-anything/kernel` | Domain model, six-state lifecycle, schemas, task projection, storage ports. |
| `@harness-anything/cli` | Local command surface for project, task, preset, module, migration, evidence, and checks. |
| `@harness-anything/application` | Shared controller/service layer used by CLI and GUI. |
| `@harness-anything/gui` | Electron GUI foundation, daemon/API contracts, renderer boundary. |
| `@harness-anything/adapter-local` | Local adapter surface. |
| `@harness-anything/adapter-multica` | Multica issue snapshot/adopt surface. |
| `@harness-anything/adapter-github-issues` | M4 placeholder for GitHub Issues. |
| `@harness-anything/adapter-linear` | M4 placeholder for Linear. |

</details>

<details>
<summary><b>Release boundary & roadmap</b> — what's real today</summary>

<br>

**Shipped:** kernel, CLI, application layer, governance checks, and Legacy
Intake readiness (M2); GUI/daemon foundation, runtime/release reproducibility,
and the supply-chain/license release gate (M2.5).

**Foundation, not product:** the GUI daemon contracts exist and are checked, but
there is no finished desktop GUI, signed installer, notarized build, or
auto-update yet.

**Not shipped:** no npm publication (packages stay `private: true` at `0.0.0`;
any future release must ship OSV, license, and SBOM evidence); GitHub Issues and
Linear adapters are still M4 placeholders.

**M2.5 GUI/daemon foundation:** public contracts exist for GUI workspace,
daemon/API, terminal, remote tunnel, and distribution policy, but release
artifacts remain unshipped. No npm package release is claimed.

**Runtime and release gates:** Use Node.js 24 or newer. The source-run smoke is
`node packages/cli/src/index.ts --json doctor`; the full local gate is
`npm run check`. Public CI covers Node 24 and Node 26, and package smoke runs
through `npm run harness:smoke-cli-package`. No signed desktop installer, notarized build, or auto-update capability is
  claimed. OSV readiness and the AGPL network-service release-note checklist are tracked in the supply-chain gate.

**Roadmap:** M2 ✓ · M2.5 ✓ · **M3** task hierarchy & relation semantics · **M4**
external adapter implementation · **M5–M7** cross-harness product line, full GUI
product, npm publication, release hardening.

Expect breaking changes while the public surface stabilizes.

</details>

<details>
<summary><b>Design principles</b> — the rules the checks enforce</summary>

<br>

- **Semantics live in the kernel.** Edge layers consume the domain model; they
  never redefine lifecycle, identity, or validation.
- **Contracts derive from one canonical source.** Command receipts, API
  registries, and schemas align to a single authority; governance checks fail
  when a surface drifts.
- **Authored state is truth; generated state is a cache.** Markdown task
  packages under Git are canonical; the SQLite projection is rebuildable and its
  integrity is verifiable.
- **Dormant code does not ship.** Placeholders are named as placeholders, and
  release gates require evidence — OSV, license, SBOM — before anything is published.

</details>

## Contributing

The most useful contributions right now are sharp bug reports, failing test
cases, architecture questions, and small documentation fixes. Before opening a
pull request, run the full local gate:

```bash
npm run check
```

Please keep public changes out of private harness state — don't add
`.harness-private/`, root-local agent instructions, or private planning docs to
public commits. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[AGPL-3.0-or-later](./LICENSE). Harness Anything stays open — including when
someone offers it as a service.
