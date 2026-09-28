# Daily commands

A cheat sheet for the commands you'll reach for most. Add `--json` to any command for structured output.

For the executable Fact → Decision → Task → Fact sequence, use the single
[first closed-loop recipe](02-first-loop.md). This page does not duplicate that
stateful workflow.

## The commands you'll use constantly

| Command | What it does |
|---|---|
| `ha init` | Create the `harness/` ledger layout and its private nested git repository. |
| `ha task create --title <title>` | Create a new task package. Add `--work <id>` to file it under a work. |
| `ha task list` | List task packages, with status / search / parent filters. |
| `ha task show <id>` | Show one task with projected status, metadata, hierarchy, relation edges, and fact anchors. |
| `ha task start <id>` | Acquire or reuse the current execution lease. |
| `ha status` | Summarize harness state. |
| `ha check` | Run harness health checks. |
| `ha graph` | Render the relation graph as a self-contained HTML panorama. |

**Organize work**

A _work_ is one root task plus the tasks filed under it. It is the only way to
group tasks; without `--work`, a task stands alone.

```bash
ha work create --title "Login hardening"      # the work's root task
ha task create --work <id> --title "Fix redirect loop"
ha work list                                  # open works with progress; --all for every work
ha work show <id>                             # goal, subtree counts, open tasks
ha agenda --work <id>                         # the agenda narrowed to one work
```

**Check & navigate**
```bash
ha status          # what state am I in?
ha check           # is everything healthy?
ha relation list --entity task/<id>
ha graph           # visualize how it all links
ha doctor          # read-only environment diagnostics
```

## The full command surface

This page covers the high-frequency subset on purpose. The authoritative, always-current reference is the CLI itself:

```bash
ha --help              # global help, or: ha help <command>
ha capabilities        # entity operations, input schemas, and examples
```

Deprecated aliases are not documented as alternate workflows; use the forms
shown by current help and by the closed-loop recipe.
