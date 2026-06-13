<div align="center">

# Harness Anything

**An agent task harness for long-horizon software work.**

<p>
  <a href="#how-it-works">How it works</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#packages">Packages</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p>
  <a href="./LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/FairladyZ625/harness-anything?style=flat&logo=github&color=yellow"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/issues"><img alt="Issues" src="https://img.shields.io/github/issues/FairladyZ625/harness-anything"></a>
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20%26%20unstable-orange">
</p>

<p>
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
</p>

</div>

---

Harness Anything gives coding agents a durable task layer: local task packages,
governance checks, migration evidence, and a small kernel that adapters, CLIs,
and GUIs can build on without owning lifecycle state.

Agents are getting better at changing code. They still need a reliable way to
carry work across long sessions, split tasks, preserve review evidence, and
prove that local state has not drifted from the repository. Harness Anything
treats that operating layer as a first-class, inspectable artifact.

## How it works

Harness Anything is organized around a small core and explicit extension
layers.

| Layer | What it does | Current status |
| --- | --- | --- |
| **Kernel** | Owns domain types, schemas, task projection, lifecycle validation, and storage ports. | Implemented in `@harness-anything/kernel`. |
| **CLI** | Exposes local commands for init, doctor, status, checks, task operations, migration evidence, and Git diff evidence. | Implemented in `@harness-anything/cli`. |
| **Application layer** | Keeps controller/service orchestration out of UI and adapter code. | Implemented in `@harness-anything/application`. |
| **GUI foundation** | Provides the Electron desktop shell and view model boundary. | Early foundation in `@harness-anything/gui`. |
| **Adapters** | Connect external systems without taking ownership of harness state. | Local and Multica surfaces exist; GitHub Issues and Linear packages are explicit M4 placeholders. |

The product model is intentionally composable:

- **Kernel first.** The kernel stays small and conservative.
- **Verticals add domain shape.** A vertical defines the task domain, contracts,
  and authored package conventions.
- **Presets add workflow choices.** Presets can add or remove templates,
  checks, and operating assumptions for a concrete use case.
- **Adapters stay at the edge.** Adapters collect or publish evidence; they do
  not become the source of truth for task lifecycle state.

## What this is

- A local-first task harness for coding-agent work.
- A TypeScript monorepo with kernel, CLI, GUI, application, and adapter
  packages.
- A governance surface for checking task packages, file complexity, import
  boundaries, private/public boundaries, schema contracts, and Legacy Intake
  readiness.
- A supply-chain release gate for high-severity npm advisories and CycloneDX
  SBOM generation.
- A clean-room rewrite workspace for the public Harness product surface.

## What this is not

- Not an agent runtime, model router, or chat UI.
- Not a replacement for Git, GitHub, or CI.
- Not a cloud task database.
- Not a published npm release yet. M2 deliberately keeps packages private and
  versions at `0.0.0`.

## Quick start

Use Node.js 24 or newer.

```bash
npm ci
npm run typecheck
node packages/cli/src/index.ts --json doctor
```

The source-entry commands rely on Node's built-in TypeScript execution support
and this repository's Node 24+ engine. For CI and release readiness, the
canonical verification path is:

```bash
npm ci
npm run check
```

The `rewrite-ci` workflow runs the public gates on Node 24 and Node 26 so source
execution, typecheck, tests, package smoke, and supply-chain checks stay aligned
with the documented runtime.

For a minimal project loop:

```bash
node packages/cli/src/index.ts --root /path/to/project --json init
node packages/cli/src/index.ts --root /path/to/project --json new-task --title "First task"
node packages/cli/src/index.ts --root /path/to/project --json status
node packages/cli/src/index.ts --root /path/to/project --json check --post-merge
```

For current coding-agent dogfood, create new work with the coding vertical and
preset surface, then complete it through the review/CI closeout gate:

```bash
node packages/cli/src/index.ts --root /path/to/project --json new-task --title "Implement slice" --vertical software/coding --preset standard-task
node packages/cli/src/index.ts --root /path/to/project --json task-complete <task-id> --ci passed --reviewer <reviewer-id>
```

Unfinished old task state is treated as Legacy Intake evidence. Rebuild it into
a new Harness task with provenance instead of expecting bulk conversion:

```bash
node packages/cli/src/index.ts --root /path/to/project --json new-task --from-legacy <legacy-id>
```

Run the full repository check before public commits:

```bash
npm run check
```

## Packages

This repository is a single Git monorepo. Packages under `packages/` are npm
workspace packages, not nested Git repositories.

| Package | Purpose |
| --- | --- |
| `@harness-anything/kernel` | Domain model, schemas, lifecycle validation, task projection, storage ports. |
| `@harness-anything/cli` | Local command surface for project, task, migration, evidence, and check workflows. |
| `@harness-anything/application` | Shared controller/service layer used by CLI and GUI surfaces. |
| `@harness-anything/gui` | Electron GUI foundation and renderer boundary. |
| `@harness-anything/adapter-github-issues` | M4 placeholder package slot for GitHub Issues integration work. |
| `@harness-anything/adapter-linear` | M4 placeholder package slot for Linear integration work. |

## Documentation

- [M1 minimal loop](./docs-release/m1-minimal-loop.md)
- [M2 coding vertical](./docs-release/m2-coding-vertical.md)
- [Harness agent skill](./docs-release/harness-agent-skill.md)
- [Minimal example project](./examples/minimal-project/)

Private planning, architecture, review state, and task ledgers live outside the
public docs tree in `.harness-private/`, which is intentionally ignored by this
repository.

## Project status

M2 Legacy Intake readiness evidence is complete for this repository workflow.

Current release boundary:

- Packages remain `private: true`.
- Workspace versions remain `0.0.0`.
- No npm package release is claimed.
- The full local gate is `npm run check`.

Expect breaking changes while the public package surface stabilizes.

## Roadmap

**M2 - coding vertical workflow**

- [x] Kernel, CLI, package layout, governance checks, behavior corpus, and
  Legacy Intake readiness evidence.
- [x] Local smoke coverage for the Legacy Intake and private CLI package
  artifact.
- [ ] npm package publication.

**Next**

- [ ] Public package release plan and package boundary review.
- [ ] GUI workflow hardening beyond the current foundation.
- [ ] External adapter implementation after the kernel/CLI contract is stable.
- [ ] More vertical and preset examples.

## Contributing

The most useful contributions right now are sharp bug reports, failing test
cases, architecture questions, and small documentation fixes.

Before opening a pull request:

```bash
npm run check
```

Please keep public changes out of private harness state. Do not add
`.harness-private/`, root-local agent instructions, or private planning docs to
public commits.

## License

[AGPL-3.0-or-later](./LICENSE). Harness Anything keeps the task harness open,
including when someone offers it as a service.
