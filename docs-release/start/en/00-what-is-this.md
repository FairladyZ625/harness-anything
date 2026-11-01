# What is this?

> **Your agent says it's done. Make it prove it.**

Harness Anything is the accountability layer for AI agents. It turns the
**decisions, tasks, and facts** your agents produce into first-class records in
an isolated private ledger git repository — queryable, reversible, and reusable
— instead of losing them inside a chat transcript.

The point is not nicer note-taking. Agents are good at doing work and bad at
being accountable for it: they forget context, drift from settled decisions, and
declare victory because checking everything by hand does not scale. You cannot
fix that with a better prompt. What works is what has always worked for people:
**a camera, and consequences.**

Put every claim on a permanent record, gate the exits, and make a false `done`
impossible to sustain. In our own self-involving use, every ungated path was
bypassed; no gate means 100% bypass.

## Try the source checkout demo

The 0.0.1 CLI candidate is not yet published to the public npm registry. Install the
source checkout once with the [harness-download skill](../../../skills/harness-download/SKILL.md):
it builds the CLI, daemon, and GUI, explains the Electron download cost before it starts,
and puts the built `ha` on PATH for the current shell. This page does not keep a second
source-install recipe.

Then run the smoke demo from the checkout:

```bash
npm run quickstart:demo
```

That run initializes a throwaway git workspace, creates a task, records a queryable fact,
and renders a relation graph. A load-bearing step that cannot produce evidence fails closed
instead of quietly passing.

The demo is not a first-run authority wizard. It requires a configured
authorization authority, a signed-in human session, and admin policy access to
the `quickstart` repository. See [Server Daemon Operations](../../operations-server-daemon.md)
for authority setup and login before running it.

After a registry publication, install the scoped package and run `ha init` with
no arguments. Until then, use the source install path above.

## What lands on disk

You run the CLI, and structure starts accumulating under `harness/`:

```text
$ ha task create --title "Fix login redirect bug"
ok command="task create" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=planned
   path=harness/tasks/task_01KWPP52D...-fix-login-redirect-bug

$ ha status
ok command=status path=.harness/cache/projections.sqlite rows=1
```

Every task, every decision, every recorded fact lands as plain Markdown inside
`harness/`. That directory is its own private nested git repository, so review
ledger diffs with `git -C harness diff`, not the outer project git diff.

![demo](../assets/demo.gif)

> **GIF coming soon** — once the GUI ships, this spot will show a short clip of
> running one loop and watching the structure grow. Until then, the static
> commands above and the smoke demo stand in.

**Three things to take away:**

- It solves the *"where did the reasoning go?"* problem — agent work stops
  evaporating into logs.
- Unlike note-taking, these are structured, linked records with a lifecycle:
  decisions can be overturned, tasks pass through gates, and facts are anchored
  to the task that observed them.
- Ready to try it? → **[Install](01-install.md)**
