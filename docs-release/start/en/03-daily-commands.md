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

## Task worktrees

A task whose output is a repository change gets its own Git worktree the first
time it is started (`ha task start`) or dispatched on a node. Harness manages
it; no worktree command is needed.

- **Name:** branch `<task-id>` in `.worktrees/<task-id>`, so the name never
  depends on the title.
- **Base:** the remote default branch that `origin/HEAD` points to; without a
  remote, the main checkout's current branch. The start receipt names the base.
- **Other tasks:** a task that changes no repository files has no worktree;
  `ha task show` and the GUI task detail show its workspace as the task package
  directory.

Declare in Settings what a fresh worktree needs. Each step is the built-in
adapter `node-modules` or `run: <command>`; steps run once, in order, inside the
worktree, with `HARNESS_TASK_ID`, `HARNESS_WORKTREE` and `HARNESS_REPO_ROOT` set.

```bash
ha settings update --worktree-setup node-modules              # npm workspaces: mirror the root node_modules
ha settings update --worktree-setup "run: uv sync"            # Python (or "run: pip install -e .")
ha settings update --worktree-setup "run: make bootstrap"     # any single command
ha settings update --worktree-setup node-modules --worktree-setup "run: npm run build"  # ordered steps
ha settings update --worktree-setup none                      # no setup
ha settings read                                              # shows worktree.setup
```

`ha init` writes `node-modules` when it detects npm workspaces and says so in
its receipt. The same list appears in the GUI repository settings panel.

If a step fails, the worktree is kept and the start or dispatch is refused. The
message names the step and its log (under the worktree's Git directory,
`harness-setup/step-<n>.log`). Fix the cause and run the same `ha task start`
or dispatch again; only the steps that have not succeeded run again.

Worktrees created before this naming (`codex/<slug>-<id8>`) are renamed once by
`ha task contract migrate --apply`. One with uncommitted changes or a live
worker is left in place and listed for you to handle.

## The full command surface

This page covers the high-frequency subset on purpose. The authoritative, always-current reference is the CLI itself:

```bash
ha --help              # global help, or: ha help <command>
ha capabilities        # entity operations, input schemas, and examples
```

Deprecated aliases are not documented as alternate workflows; use the forms
shown by current help and by the closed-loop recipe.
