<div align="center">

# Harness Anything

**Every agent run should make your repository smarter.**

Harness Anything is the self-evolving harness for self-evolving repositories.
It turns decisions, failures, facts, and reviews into durable project memory —
then gates *"done"* so progress compounds instead of evaporating into chat.

<p>
  <a href="#quickstart"><b>Get started</b></a> |
  <a href="#why-it-compounds">Why it compounds</a> |
  <a href="#how-it-works">How it works</a> |
  <a href="#documentation">Docs</a>
</p>

<p>
  <a href="https://skills.sh/FairladyZ625/harness-anything"><img alt="Skills installs" src="https://skills.sh/b/FairladyZ625/harness-anything"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/pr-body.yml"><img alt="PR body checks" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/pr-body.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/FairladyZ625/harness-anything?style=flat&logo=github&color=yellow"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-24%2B-brightgreen">
  <a href="./LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20%26%20unstable-orange">
</p>

<p>
  <a href="./README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

</div>

---

## Quickstart

Open your project in your coding agent and paste this prompt to get started:

```text
Read skills/harness-download/SKILL.md from https://github.com/FairladyZ625/harness-
anything and use it to guide me through first-time Harness Anything setup: check the
environment, download the source to a persistent directory, symlink the full skill
set into my selected agents’ user directories, then initialize this repository, set
up the CEO knowledge locations, and complete one real task with harness-ceo. Read
information available in the project and environment directly. When a choice or
approval is needed, show me the concrete proposal first, and do not ask again about
something I have already confirmed.
```

<details>
<summary>Skills installation options and setup details</summary>

Install the onboarding skill for the agents you use. This example selects Codex
and Claude Code; omit an agent you do not use, or choose other supported agents
interactively:

```bash
bunx skills add FairladyZ625/harness-anything --skill harness-download -g -a codex claude-code
```

Without Bun, replace `bunx` with `npx`. Bun runs the Skills installer; Harness
itself currently runs on Node 24+ from a persistent source checkout.

The agent continues through each stage:

| Skill | Responsibility |
| --- | --- |
| [harness-download](./skills/harness-download/SKILL.md) | Prepare the environment and persistent source checkout, link the skills, and coordinate the remaining setup |
| [harness-install](./skills/harness-install/SKILL.md) | Adopt the available Harness installation in a target repository, preserving existing instructions and identity approvals |
| [harness-ceo](./skills/harness-ceo/SKILL.md) | Initialize user-owned knowledge locations, select models, carry out real work, and verify delivery |

Download the tools once. Use `harness-install` for another repository and
`harness-ceo` for daily work. User model matrices, issue records, and feedback
stay in the workspace; public skill updates do not overwrite them.

You can also inspect or install the complete skill set:

```bash
bunx skills add FairladyZ625/harness-anything --list
bunx skills add FairladyZ625/harness-anything --skill '*' -g -a codex claude-code
```

The Skills CLI's installed copy is separate from the source installation. The
onboarding flow then links the selected agents to the persistent source checkout.
Existing customized skills with the same name are checked for conflicts, not
automatically overwritten. Moving the source directory breaks those links, so do
not keep it in a temporary location.

An existing, usable current-generation ledger is reused. Only an identified older
generation is routed to [harness-migration](./skills/harness-migration/SKILL.md);
an existing directory alone does not authorize overwriting or migration.

See the [official Skills CLI documentation](https://github.com/vercel-labs/skills)
for installation syntax and agent directory selection. Skills can be discovered
directly from GitHub. Listing and indexing on [skills.sh](https://skills.sh/docs)
are controlled by that service; adding repository documentation does not prove
that the service has indexed it.

</details>

## Your agent can write code. Can your project learn?

Most agent runs are disposable. The reasoning stays in a transcript, settled
decisions get reopened, the same mistakes return, and *"done"* is whatever the
agent says it is.

Harness Anything makes the work accumulate:

| Without a harness | With Harness Anything |
| --- | --- |
| Reasoning disappears with the session | Decisions and facts become durable project memory |
| The next agent repeats old mistakes | Failures can become rules, checks, and better workflows |
| Completion is a claim | Completion is a state earned through gates |

This is not a better chat log. It is a compounding loop for how agents work in
your repository.

## Why It Compounds

```text
DECIDE → WORK → VERIFY → LEARN → THE NEXT RUN STARTS STRONGER
```

### Memory that survives the session

Every task leaves behind the context that matters: what was decided, what was
tried, what was observed, and what remains unresolved. The next agent starts
from project memory instead of reconstructing history from scratch.

### Mistakes that become infrastructure

A failure should pay rent. Capture it as a fact, turn a recurring lesson into a
decision, check, or preset, and the repository becomes harder to break in the
same way twice.

### “Done” that means something

Agents do not get to close work by confidence alone. A six-field Submission
Packet gives the reviewer a traceable claim and inspection entry points; the
reviewer records what was checked and why the round is or is not acceptable.
Completion then applies the gates declared by the task's resolved preset/profile
contract. Coding contracts can require CI, but the kernel requires neither CI
nor any minimum number of Facts universally (dec_mrg3z1we/CH1, CH4; ADR-0027
D5-D7).

## Self-Involving By Design

Harness Anything is developed through Harness Anything.

Its own tasks, decisions, facts, reviews, and completion gates run through the
same system it gives your repository. The harness observes its own failures,
turns lessons into stronger constraints, and uses those constraints on the next
round of development.

That is what *self-evolving* means here: not magic, and not autonomous churn.
Each completed loop leaves the system better equipped for the next one. Your
repository gets the same compounding mechanism.

## Run the demo

Harness Anything currently runs from a source checkout and requires Node.js
24+. Run the 30-second smoke demo:

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run quickstart:demo
```

The demo builds the CLI, creates a throwaway project, runs a real task loop, and
shows the records that remain after the agent work is over.

To use the Electron GUI from this source installation, link the built CLI once,
then launch it from the repository you want to open:

```bash
npm run build -w @harness-anything/cli
(cd packages/cli && npm link)
ha gui
```

`ha gui` is the production GUI entry. It builds the renderer, obtains the
default daemon through the CLI, and detaches Electron; closing the window never
stops the daemon. The package-local `npm run dev:electron` script is only a
contributor hot-reload tool.

Ready to use it on a project? Continue with the
[Start guide](./docs-release/start/en/00-what-is-this.md).

## Breaking change: existing repositories must migrate

The ledger format has changed by a generation and this project keeps no
backward compatibility, so existing repositories cannot be upgraded in place.
The old repository is archived read-only and replayed into a new one; it is
never at risk.

**You do not have to do this by hand, and you do not need the current version
installed first.** Paste this to a coding agent working in the repository you
want to migrate:

> Read `skills/harness-migration/SKILL.md` from
> https://github.com/FairladyZ625/harness-anything and
> follow it to migrate this project's `harness/` ledger to the current format.
> Ask me before each decision the skill says to ask about.

The skill fetches the current source into a temporary directory and runs
everything from there, so an older Harness installation on the same machine —
including a running daemon — is left untouched. It stops and asks you at each
point where a choice destroys something: file conflicts between your ledger and
the freshly initialized one, records the strict format rejects, and presets that
must be rebuilt rather than copied.

Prefer to drive it yourself? The [migration guide](./docs-release/migration-genesis-replay.md)
is the same procedure in reference form.

## How It Works

Harness Anything gives agent work three durable primitives:

- **Decision** — what was chosen, what was rejected, and why.
- **Task** — what is being changed, its plan, progress, review, and closeout.
- **Fact** — what was actually observed, with source and confidence.

They live as plain Markdown inside a private nested git ledger. Git provides the
history; a rebuildable projection makes the records queryable; gates control
which state transitions are allowed.

The result is a repository that remembers more than its code:

- why its architecture looks the way it does;
- which attempts failed and should not be repeated;
- which work is truly complete and which claims remain open;
- how its own development process should improve next.

## Documentation

- [Start](./docs-release/start/en/00-what-is-this.md) — install it and run one real loop. ([中文](./docs-release/start/zh/00-what-is-this.md))
- [Learn](./docs-release/learn/en/00-overview.md) — understand the memory model, gates, and compounding loop. ([中文](./docs-release/learn/zh/00-overview.md))
- [Architecture](./docs-release/architecture/en/00-overview.md) — explore the kernel, storage model, write path, and projections. ([中文](./docs-release/architecture/zh/00-overview.md))
- [Release posture](./docs-release/release-posture.md) — see what is shipped, foundational, or planned.
- [Harness CEO](./skills/harness-ceo/SKILL.md) — model-neutral delegation, evidence-based acceptance, and onboarding and improvement methods for user-owned model matrices.
- [Migration](./docs-release/migration-genesis-replay.md) — replay an older-generation ledger into the current format. ([agent skill](./skills/harness-migration/SKILL.md))
- [Ledger recovery](./docs-release/migration-legacy-ledger-recovery.md) — repair a repository whose legacy ledger the current daemon refuses to attach. ([中文](./docs-release/migration-legacy-ledger-recovery.zh-CN.md))
- [Minimal example](./examples/minimal-project/) — inspect the smallest working project.

## Contributing

Sharp bug reports, failing test cases, architecture questions, and focused
documentation fixes are especially useful right now. See
[CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## License

[AGPL-3.0-or-later](./LICENSE). Harness Anything stays open, including when it
is offered as a service.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=FairladyZ625/harness-anything&type=Date)](https://star-history.com/#FairladyZ625/harness-anything&Date)
