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

Cold daemon startup also prints progress on stderr so an invocation does not
remain silent while authority readiness is pending. Set `HA_PROGRESS=0` only
when a caller deliberately suppresses those human-readable progress messages;
it does not change daemon or authority behavior.
