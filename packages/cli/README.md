# @harness-anything/cli

CLI Controller package. It must call kernel services rather than own lifecycle
state.

## Doctor

`harness doctor --json` emits `harness-doctor/v1` diagnostics. The command is
read-only: it checks Node.js, Git worktree status, authored `harness/` presence,
local `.harness/` presence, and projection cache presence without creating or
repairing files.

Use it before task work and after installing the package artifact:

```bash
harness doctor --json
harness status --json
harness check --post-merge --json
```
