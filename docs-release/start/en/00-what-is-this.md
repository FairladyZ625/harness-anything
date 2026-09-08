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

## See the 30-second proof first

The 0.0.1 CLI candidate is installable from a local npm tarball. The fastest
path today is the source checkout smoke demo:

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run quickstart:demo
```

That run builds the CLI, initializes a throwaway git workspace, creates a task,
records a queryable fact, and renders a relation graph. A load-bearing step that
cannot produce evidence fails closed instead of quietly passing.

After a registry publication, install the scoped package and run `ha init` with
no arguments. Until then, use the local tarball or source checkout path above.

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
