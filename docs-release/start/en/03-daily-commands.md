# Daily commands

A cheat sheet for the commands you'll reach for most. Add `--json` to any command for structured output.

## The commands you'll use constantly

| Command | What it does |
|---|---|
| `ha init` | Create the `harness/` directory layout in the current repo. |
| `ha task create --title <title>` | Create a new task package. |
| `ha task list` | List task packages, with state / module / search filters. |
| `ha task show <id>` | Show one task with projected status, metadata, hierarchy, relation edges, and fact anchors. |
| `ha task transition <id> <state>` | Move a task to a new lifecycle state. |
| `ha decision propose --title <t> ...` | Propose a decision (question, chosen, rejected, why-not). |
| `ha decision accept <id>` | Adjudicate a proposed decision — the evidence checkpoint. |
| `ha fact record --task <id> --statement <text>` | Record an append-only fact anchored to a task. |
| `ha status` | Summarize harness state. |
| `ha check` | Run harness health checks. |
| `ha graph` | Render the relation graph as a self-contained HTML panorama. |

## By scenario

**Task lifecycle**
```bash
ha task create --title "Implement slice"
ha task transition <id> active
ha task progress append <id> --text "Implemented first slice"
```

**Decisions**
```bash
ha decision propose --title "..." --question "..." --chosen "..." --rejected "..." --why-not "..."
ha decision accept <id>       # or: reject | defer
ha decision list --state active
```

**Facts**
```bash
ha fact record --task <id> --statement "..." --source "..." --confidence high
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

Some older command spellings still work as deprecated aliases and will be retired in a future release — prefer the forms shown above.
