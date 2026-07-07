<div align="center">

# Harness Anything

**Your agent says it's done. Make it prove it.**

Harness Anything is the accountability layer for AI agents: every decision,
task, and fact your agent produces becomes auditable structure on git — and
*"done"* has to get past a gate, with evidence.

<p>
  <a href="#quickstart">Quickstart</a> ·
  <a href="#recipes">Recipes</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#under-the-hood">Under the hood</a>
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
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
</p>

</div>

---

```console
$ ha task create --title "Add rate limiting to /api/upload"
ok  task_01KWVVJC94 · planned

# ── the agent hacks away for a while, then announces victory ──

$ ha task transition task_01KWVVJC94 done
error  code=terminal_status_requires_task_complete
       "done" is earned through the completion gate, not declared.

$ ha task complete task_01KWVVJC94 --ci passed
error  code=task_fact_required
       completion requires at least one recorded fact. Show your evidence.

$ ha fact record --task task_01KWVVJC94 \
    --statement "429 returned after 100 req/min; regression suite green" \
    --source "npm test -- rate-limit.spec.ts" --confidence high
ok  fact recorded to the task ledger

$ ha task complete task_01KWVVJC94 --ci passed --reviewer alex
error  code=review_placeholder
       a template is not a review. Write a real verdict.

# ── one real review verdict later ──

$ ha task complete task_01KWVVJC94 --ci passed --reviewer alex
ok  task_01KWVVJC94 · done — evidence sealed, on the record, in git
```

Every `error` above is real output. The agent didn't get to say "done" until it
showed its work.

## Why

Every agent user knows the moment. *"All tests passing — the feature is
complete!"* No tests were run. The plan you agreed on three sessions ago has
quietly mutated. The reasoning behind last month's architecture change is
buried in a chat log nobody will ever scroll back to.

Agents are astonishingly good at *doing* work and astonishingly bad at being
*accountable* for it. They forget — context compacts, sessions end. They drift
— settled decisions get silently re-litigated. And they declare victory —
because checking everything yourself doesn't scale.

You will not fix this with a better prompt. You can't stop an agent from
cutting a corner in the moment, any more than you can stop a person. What works
is what has always worked for people: **a camera, and consequences.** Put every
claim on a permanent record, gate the exits, and make a false "done"
impossible to sustain.

We didn't design these gates on a whiteboard. Harness Anything manages its own
development, and while it did, we watched our own agents take every ungated
path to "done" — **100% of the time**. Agents follow the only path that
exists. So we made evidence the only path.

## How it works

Everything your agent produces becomes one of **three primitives**, written as
plain markdown into your repository:

- **Decision** — the *why*. A choice with alternatives, rationale, and a named
  arbiter. Decisions can be overturned, never erased.
- **Task** — the *what*. A six-state lifecycle validated in exactly one place,
  with `done` locked behind a completion gate.
- **Fact** — the *evidence*. Append-only observations with sources. Facts can
  be invalidated by newer facts, never edited.

Three properties make the record trustworthy:

- **It's git.** The whole ledger is plain markdown under version control —
  grep it, diff it, review it in a PR. No database to babysit, no lock-in.
  A SQLite projection gives fast queries and can be deleted and rebuilt from
  the markdown at any time; the files are the truth.
- **Gates fail closed.** `done` requires recorded facts, a schema-checked
  review verdict, a real closeout, and a CI result. Placeholder text is
  rejected. There is no ungated path.
- **Nothing is off the record.** Progress, reviews, decisions, and evidence
  accumulate in the task package. When something goes wrong next month, you
  replay the record instead of interrogating a vanished chat session.

And it's just a CLI. Anything that can run a shell can be harnessed — Claude
Code, Codex, your homegrown agent, the human next to you. Nothing about
decision / task / fact is coding-specific: it governs any long-horizon work
you delegate to an agent. Hence the name.

## Quickstart

> **Not on npm yet.** Harness Anything installs globally from a source
> checkout while the CLI surface stabilizes. Requires **Node.js 24+** and git.

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run build -w @harness-anything/cli
npm install -g ./packages/cli    # installs the `ha` command
ha doctor                        # read-only environment check
```

Then run the first loop inside any git project:

```bash
cd /path/to/your/project
ha init                                            # scaffold ./harness
ha task create --title "First task"                # returns a task_<id>
ha task transition <task-id> active
ha fact record --task <task-id> \
  --statement "what was verified" --source "the command or path that proves it"
ha status
```

That's the whole trick: the task, the evidence, and every claim in between are
now versioned files in your repo — reviewable in a diff, and still there next
session, next month, next agent.

## Recipes

```bash
# Put a choice on the record — alternatives, rationale, arbiter
ha decision propose --title "Rate limiter algorithm" \
    --question "Sliding window or token bucket?" \
    --chosen "Sliding window" --rejected "Token bucket" \
    --why-not "Burst tolerance not needed at this tier"
ha decision accept dec_01ABC --arbiter human:you

# Record evidence while the work happens
ha fact record --task task_01ABC --statement "p95 latency 84ms after cache" \
    --source "npm run bench" --confidence high

# Close a task through the review + CI + evidence gate
ha task transition task_01ABC in_review
ha task review task_01ABC --reviewer alex
ha task complete task_01ABC --ci passed --reviewer alex

# Interrogate the record
ha task list --state in_review
ha decision list --search "rate limit"
ha fact list --task task_01ABC

# Prove local state still matches the repository
ha check
```

The CLI (`harness-anything`, alias `ha`) exposes 50+ commands across tasks,
decisions, facts, evidence, migration intake, and an extension surface. The
daily command reference lives in the
[Start guide](./docs-release/start/en/03-daily-commands.md), and the tool
itself is always current: `ha --help` and `ha capabilities`.

## Documentation

Three tracks, shallow to deep:

- [Start](./docs-release/start/en/00-what-is-this.md) — install, run one real loop, daily commands. ~10 minutes. ([中文](./docs-release/start/zh/00-what-is-this.md))
- [Learn](./docs-release/learn/en/00-overview.md) — the ideas: the three-primitive kernel, gates and fail-closed, the adoption law. ([中文](./docs-release/learn/zh/00-overview.md))
- [Architecture](./docs-release/architecture/en/00-overview.md) — the machine: storage model, write path, projection, gates in the pipeline. ([中文](./docs-release/architecture/zh/00-overview.md))

Plus: [Release posture](./docs-release/release-posture.md) — what is shipped,
what is foundation-only, and what remains planned — and a
[minimal example project](./examples/minimal-project/).

## Under the hood

<details>
<summary><b>Architecture</b> — a small kernel, everything else consumes it</summary>

<br>

The kernel is the single semantic authority. It owns the domain model — the
three primitives, task identity, the six-state lifecycle, schemas, and the
storage ports everything else consumes. Lifecycle transitions are validated in
exactly one place; no edge layer gets to redefine what "done" means.

Everything around the kernel is a consumer. The CLI parses commands and renders
receipts, the GUI foundation maps daemon and API contracts, the application
layer keeps orchestration out of UI code, and adapters collect or publish
evidence at the boundary. Contracts — command receipts, API registries, schemas
— derive from one canonical source rather than being re-declared per surface.

Authored state is plain markdown under git; generated state is a rebuildable
cache. The markdown is the truth, the SQLite projection is derived from it, and
`ha check` can always prove whether the two agree.

| Layer | What it does |
| --- | --- |
| **Kernel** | Three primitives, domain types, six-state lifecycle, schemas, projections, storage ports. |
| **CLI** | Local commands for init, doctor, status, checks, tasks, decisions, facts, presets, modules, migration, and evidence. |
| **Application** | Keeps controller/service orchestration out of UI and adapter code. |
| **GUI foundation** | Electron shell, daemon/API contracts, session policies, distribution/update boundary. Foundation, not a finished product. |
| **Adapters** | Connect external systems without owning harness state. |

</details>

<details>
<summary><b>Core concepts</b> — primitives, evidence, gates, lifecycle</summary>

<br>

- **Decision** — an overturnable choice: question, chosen path, rejected
  alternatives, why-not, and a named arbiter. Related to tasks and facts
  through typed, rationale-carrying relations. Superseded, never deleted.
- **Task** — a markdown package under `harness/tasks/` with a random
  `task_<ULID>` identity holding the plan, progress, facts, review, and
  closeout for one unit of work. Six states: `planned`, `active`, `blocked`,
  `in_review`, `done`, `cancelled`. Terminal states are reached only through
  the completion gate; follow-up work uses supersede, not reopen.
- **Fact** — an append-only observation with a statement, a source, and a
  confidence level. Review and completion both require real facts; facts are
  invalidated by newer facts, never edited in place.
- **Gate** — the fail-closed checks on load-bearing writes: fact required,
  review verdict schema-checked, closeout placeholders rejected, CI result
  demanded. Errors are typed (`task_fact_required`, `review_placeholder`, …)
  so agents get machine-readable instructions for the legitimate path.
- **Vertical & preset** — a vertical (like `software/coding`) defines the task
  domain and its contracts; a preset layers workflow choices — templates,
  checks, actions — on top.
- **Module** — a registered slice of the project that tasks can target, so
  multi-module work stays filterable and scoped.

</details>

<details>
<summary><b>Packages</b> — the monorepo layout</summary>

<br>

One git monorepo. Packages under `packages/` are npm workspace packages (not
nested repos). Only the CLI workspace is public-ready for dry-run preflight;
nothing is published to npm yet.

| Package | Purpose |
| --- | --- |
| `@harness-anything/kernel` | Domain model, three primitives, lifecycle, schemas, projections, storage ports. |
| `@harness-anything/cli` | Local command surface for project, task, decision, fact, preset, module, migration, evidence, and checks. The only workspace prepared for npm publish dry-run preflight. |
| `@harness-anything/application` | Shared controller/service layer used by CLI and GUI. |
| `@harness-anything/gui` | Electron GUI foundation, daemon/API contracts, renderer boundary. |
| `@harness-anything/adapter-local` | Local adapter surface. |
| `@harness-anything/adapter-multica` | Multica issue snapshot/adopt surface. |
| `@harness-anything/adapter-github-issues` | Placeholder for GitHub Issues. |
| `@harness-anything/adapter-linear` | Placeholder for Linear. |

</details>

<details>
<summary><b>Release boundary</b> — what's real today</summary>

<br>

The single public anchor for release governance is
[Release posture](./docs-release/release-posture.md): what is shipped, what is
foundation-only, and what remains planned, plus the supply-chain and license
gates any future release must pass.

The short version: the kernel, CLI, and governance checks are real and in
daily use — this repository is developed under its own harness.
No npm package release is claimed. Only the CLI package is public-ready for
`npm publish --dry-run`; all other workspace packages stay `private: true`, and
a real release must ship OSV, license, and SBOM evidence first. The M2.5 GUI/daemon foundation ships
contracts and policies only.
No signed desktop installer, notarized build, or auto-update capability is
  claimed.

**Runtime and gates:** Use Node.js 24 or newer. The source-run smoke is
`node packages/cli/src/index.ts --json doctor`; the full local gate is
`npm run check`. Public CI covers Node 24 and Node 26, and package smoke runs
through `npm run harness:smoke-cli-package`. OSV readiness and the AGPL
network-service release-note checklist are tracked in the supply-chain gate.

Expect breaking changes while the public surface stabilizes.

</details>

<details>
<summary><b>Design principles</b> — the rules the checks enforce</summary>

<br>

- **The only path is the gated path.** Agents adopt whatever route exists;
  leave an ungated shortcut and it will be taken. So load-bearing writes are
  validated, and validation fails closed.
- **Semantics live in the kernel.** Edge layers consume the domain model; they
  never redefine lifecycle, identity, or validation.
- **Contracts derive from one canonical source.** Command receipts, API
  registries, and schemas align to a single authority; governance checks fail
  when a surface drifts.
- **Authored state is truth; generated state is a cache.** Markdown under git
  is canonical; the SQLite projection is rebuildable and its integrity is
  verifiable.
- **Dormant code does not ship.** Placeholders are named as placeholders, and
  release gates require evidence — OSV, license, SBOM — before anything is
  published.

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
