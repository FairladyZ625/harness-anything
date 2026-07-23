# @harness-anything/cli

CLI Controller package. It must call kernel services rather than own lifecycle
state.

The canonical CLI command is `harness-anything`. `ha` is a short alias with the
same behavior for interactive use. Public examples prefer `harness-anything`
unless they are documenting the alias itself.

## Doctor

`harness-anything doctor --json` emits `harness-doctor/v1` diagnostics. The command is
read-only: it checks Node.js, Git worktree status, authored `harness/` presence,
local `.harness/` presence, and projection cache presence without creating or
repairing files.

Use it before task work and after installing the package artifact:

```bash
harness-anything doctor --json
harness-anything status --json
harness-anything check --post-merge --json
```

## CLI timing diagnostics

Set `HA_TIMING=1` to emit one `ha-cli-timing/v1` record on stderr when the
process exits. The record separates process startup, module loading, parsing,
daemon configuration and target resolution, connection, daemon launch plus
authority readiness, command execution, and any event-loop exit wait. Normal
command output remains unchanged on stdout.

```bash
HA_TIMING=1 ha task show task_01ABC --json
```

Every daemon-backed CLI command that remains in flight beyond the progress
threshold prints a non-terminal notice on stderr. The notice means the command
is still running and the final receipt has not been returned; it never means
the caller should run the command again. Human users keep waiting for the
current process. Agent tools that yield a process/session must continue reading
that same session until it exits and returns the final receipt.

Progress never contaminates stdout, including with `--json`, and successful
commands still return exactly one final receipt after completion. Set
`HA_PROGRESS=0` only when a caller deliberately suppresses these human-readable
progress messages; it does not change daemon, authority, durability, or receipt
behavior.

## Desktop GUI launcher

`ha gui` resolves the current Harness project from the caller's working
directory, but it never executes package scripts from that project. GUI launch
is client-local and does not run inside the global daemon snapshot.

The launcher supports the complete installed desktop product and trusted source
development:

- a packaged CLI discovers the GUI executable in the same desktop artifact;
- package managers may expose `harness-anything-gui` on `PATH`;
- standard macOS, Windows, and Linux installation locations are checked;
- `HARNESS_GUI_EXECUTABLE` registers a non-standard installation explicitly;
- a workspace-local CLI may use the verified `@harness-anything/gui` source
  checkout for development.

Every launch passes the selected project as `HARNESS_GUI_ROOT`. If the complete
desktop product is absent, the command reports an installation error instead of
treating the target project as executable code.
