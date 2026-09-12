# Daily commands

A cheat sheet for the commands you'll reach for most. Add `--json` to any command for structured output.

For the executable Fact → Decision → Task → Fact sequence, use the single
[first closed-loop recipe](02-first-loop.md). This page does not duplicate that
stateful workflow.

## The commands you'll use constantly

| Command | What it does |
|---|---|
| `ha init` | Create the `harness/` ledger layout and its private nested git repository. |
| `ha task create --title <title>` | Create a new task package. |
| `ha task list` | List task packages, with state / module / search filters. |
| `ha task show <id>` | Show one task with projected status, metadata, hierarchy, relation edges, and fact anchors. |
| `ha task start <id>` | Acquire or reuse the current execution lease. |
| `ha status` | Summarize harness state. |
| `ha check` | Run harness health checks. |
| `ha graph` | Render the relation graph as a self-contained HTML panorama. |

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
