# @harness-anything/cli

CLI Controller package. It must call kernel services rather than own lifecycle
state.

The canonical CLI command is `harness-anything`. `ha` is a short alias with the
same behavior for interactive use. Public examples prefer `harness-anything`
unless they are documenting the alias itself.

## Install the 0.0.1 candidate

Build and install the scoped CLI from this checkout. The package is a release
candidate and is not claimed as published to npm:

```bash
npm pack --workspace @harness-anything/cli
npm install --global ./harness-anything-cli-0.0.1.tgz
ha init
```

With no options, `init` uses the current directory name as the repository id
and local git `user.name` for the owner display name and derived person id.

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
