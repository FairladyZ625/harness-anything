# What is this?

Harness Anything makes the **decisions, tasks, and facts** your AI agents produce into first-class records on git — queryable, reversible, and reusable — instead of losing them inside a chat transcript.

You run one command, and structure starts accumulating in your repo:

```text
$ ha task create --title "Fix login redirect bug"
ok command="task create" task=task_01KWPP52D062Q7BWTD8BCNDRWF status=planned
   path=harness/tasks/task_01KWPP52D...-fix-login-redirect-bug

$ ha status
ok command=status path=.harness/cache/projections.sqlite rows=1
```

Every task, every decision, every recorded fact lands as plain Markdown you can review in a normal git diff.

![demo](../assets/demo.gif)

> **GIF coming soon** — once the GUI ships, this spot will show a short clip of running one loop and watching the structure grow. Until then, the static commands above stand in.

**Three things to take away:**

- It solves the *"where did the reasoning go?"* problem — agent work stops evaporating into logs.
- Unlike note-taking, these are structured, linked records with a lifecycle: decisions can be overturned, facts are anchored to the task that observed them.
- Ready to try it? → **[Install](01-install.md)**
