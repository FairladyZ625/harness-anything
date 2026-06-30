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
