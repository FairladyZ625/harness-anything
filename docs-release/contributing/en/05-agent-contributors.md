# Agent contributors

Coding agents are welcome as implementation assistants, but they must follow the
same public contribution contract as humans. An agent that can edit files but
cannot respect scope, evidence, and merge authority is not ready to work on this
repository.

## Give the agent this read set

At minimum, point the agent to:

- this contributing path;
- the root README and `docs-release/`;
- `.github/pull_request_template.md`;
- the specific files named by the task or issue;
- package scripts in `package.json`;
- relevant tests next to the changed code.

For code involving a library, framework, SDK, CLI, or cloud service, the agent
should consult current official docs rather than relying on memory.

## Agent ground rules

The agent must:

- state the task scope before editing;
- work on a branch or worktree, not shared `main`;
- inspect current code before proposing abstractions;
- keep edits inside the stated scope;
- use existing package boundaries and helpers;
- run relevant checks and report exact results;
- preserve unrelated local changes;
- stage only files it changed for the task;
- keep private notes, local paths, and credentials out of public diffs.

The agent must not:

- add compatibility shims for hypothetical users before the release boundary
  asks for them;
- rewrite unrelated files for style;
- bypass generated gates or remove failing tests to make CI green;
- open a PR with an empty verification section;
- merge, force-push, or direct-push to `main` unless a maintainer explicitly
  grants that authority for that exact operation.

## Agent-created tasks and evidence

If a maintainer asks the agent to use Harness Anything task records, the agent
should use the current CLI:

```bash
ha task create --title "<title>" --vertical software/coding --preset standard-task
ha task progress append <task-id> --text "<progress>"
ha fact record --task <task-id> --statement "<observed fact>" --source "<source>" --confidence high
```

Do not hand-scaffold task directories. If the CLI cannot create or update the
task package, stop and report the blocker.

## Agent PR handoff

Before asking for review, the agent should leave a compact handoff:

- what changed;
- what did not change;
- commands run;
- commands not run and why;
- known residual risk;
- files that need human attention.

This handoff belongs in the PR body or review comment, not in private local
notes that reviewers cannot see.

## Merge boundary for agents

An external contributor's agent has proposal authority only. It can create a
branch, make commits, run checks, and open or update a PR. It cannot decide that
the PR is allowed into `main`.

Only maintainers, the owner, or a maintainer-authorized admin agent may merge,
and only after the CI and review gates described in this path are satisfied.
