# Harness Anything

> **Your agent says it's done. Make it prove it.**

Harness Anything is the accountability layer for AI agents: every decision,
task, and fact your agent produces becomes auditable structure on git — and
`done` has to get past a gate, with evidence.

You cannot stop an agent from cutting a corner in the moment. What works is the
old human pattern: **a camera, and consequences.** Put the claim on a permanent
record, gate the exits, and make a false "done" impossible to sustain. In our
own dogfood, every ungated path was bypassed; no gate means 100% bypass.

## Run the 30-second proof

The current public path is source checkout first. There is no public npm package
yet, so do not treat `npx harness-anything init` as available today.

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run quickstart:demo
```

That smoke run builds the CLI, initializes a throwaway git workspace, creates a
task, records a queryable fact, and renders the relation graph. If a load-bearing
step cannot produce evidence, the run fails closed instead of pretending the
work is done.

The lifecycle gate is real. In a local source build, a task cannot be shoved to
`done` by declaration:

```console
$ ha task transition task_01KWX5RBJQMEZ2T7AR6GFB8Q6K done
error code=terminal_status_requires_task_complete

$ ha task complete task_01KWX5RBJQMEZ2T7AR6GFB8Q6K --ci passed
error code=task_fact_required
```

That is the current boundary.

After the 0.1 package publication to npm, the first-contact path becomes:

```bash
npx harness-anything init
```

Until that release exists, use the source checkout path above, or build and
install the local CLI with `npm install -g ./packages/cli`.

## The three primitives

- **decision** — the WHY. A choice with alternatives, rationale, and a named
  arbiter. Decisions can be overturned, never erased.
- **task** — the WHAT. A unit of work moving through a six-state lifecycle, with
  `done` locked behind completion gates.
- **fact** — the EVIDENCE. An append-only observation anchored to the task that
  produced it.

The `ha` CLI writes plain Markdown into your git repo and keeps a rebuildable
SQLite projection for fast queries. Grep it, diff it, review it in a PR.

---

## Start here

Run the smoke demo, then walk the first real loop.

→ **[start/](start/en/00-what-is-this.md)**

## Contribute without bypassing the gates

Want to help build Harness Anything, or point an agent at the repo? Start with
the contribution path: local setup, change flow, CI evidence, PR review, merge
authority, and agent-specific rules.

→ **[contributing/](contributing/en/00-overview.md)**

## Understand why it's built this way

The design is deliberate. This path walks through the primitive kernel, decision
adjudication, gates, the extension model, and the adoption law.

→ **[learn/](learn/en/00-overview.md)**

## See how it's actually built

Finished `learn/` and wondering how the system delivers on those claims? This
path is the mechanism: storage, the write path, projection, gates, provenance,
and the vertical engine.

→ **[architecture/](architecture/en/00-overview.md)**

## Check the release posture

Before using release, GUI, daemon, remote, adapter, or packaging language in
public docs, check the single status authority.

→ **[release-posture.md](release-posture.md)**

## Understand the daemon boundary

Use the daemon docs for the operations shape and its current limits: local daemon
service management, repository registration, direct-push protection, read-only
mirrors, and the remote boundary.

→ **[operations-server-daemon.md](operations-server-daemon.md)**
