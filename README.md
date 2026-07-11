<div align="center">

# Harness Anything

**Every agent run should make your repository smarter.**

Harness Anything is the self-evolving harness for self-evolving repositories.
It turns decisions, failures, facts, and reviews into durable project memory —
then gates *"done"* so progress compounds instead of evaporating into chat.

<p>
  <a href="#quickstart"><b>Run the demo</b></a> |
  <a href="#why-it-compounds">Why it compounds</a> |
  <a href="#how-it-works">How it works</a> |
  <a href="#documentation">Docs</a>
</p>

<p>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
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

## Quickstart

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

Ready to use it on a project? Continue with the
[Start guide](./docs-release/start/en/00-what-is-this.md).

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
- [Minimal example](./examples/minimal-project/) — inspect the smallest working project.

## Contributing

Sharp bug reports, failing test cases, architecture questions, and focused
documentation fixes are especially useful right now. See
[CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## License

[AGPL-3.0-or-later](./LICENSE). Harness Anything stays open, including when it
is offered as a service.
