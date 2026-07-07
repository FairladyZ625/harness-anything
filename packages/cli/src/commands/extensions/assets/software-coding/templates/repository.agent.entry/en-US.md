# Harness Agent Entry

This standalone entry is kept for compatibility. Current milestone context and temporary read sets belong in the active task package, not in AGENTS.md.

## Context loading

- Read `harness/harness.yaml`.
- If a task is assigned, read `task_plan.md`, `read_set.md`, and the files explicitly named there.
- Load only the standards or folder README files relevant to the task.

## Worktree discipline

- Public implementation, public docs PRs, and background/parallel workers use `.worktrees/<slug>` on `codex/<slug>` from latest `origin/main`.
- Do not edit public source, public docs, or root public config from the shared repository root.

## Harness CLI

- Invoke via `ha <command>` or `npx harness-anything <command>`.
- Create task packages with `ha task create --title "<title>" --vertical software/coding --preset <id>`; never hand-scaffold directories under the tasks root.
- Choose the preset before creating a task. Use `create-milestone` for milestone root creation; if unsure, run `ha preset list`.
- Prefer `ha <command> --help`, preset manifests, and capabilities metadata before composing writes.
- Record load-bearing observations with `ha fact record --task <id> --statement "<verifiable observation>" --source "<source>" --confidence high`.
- Query through projections with `ha decision list --state active --module <key> --compact`, `ha decision show <id|E<n>>`, and `ha task list --module <key>`.

## Relation edge rules

- Use canonical decision ids for relation writes. Legacy `E<n>` selectors are projection-read conveniences; do not assume write commands accept them.
- Decision-to-task edges use `derives` when the decision spawned the task and `relates` when the task was later found connected.
- `refines` is for decision-to-decision revision, not for target `task/...`.

## Write discipline

- Harness CLI writes are auto-committed when the harness root is inside a Git repository. Do not add a second commit for coordinator-owned writes.
- Hand-edited prose, standards, templates, artifact indexes, or source files must be committed by the agent that changed them, staging only task-touched paths.
- Template assets are operating surface. When AGENTS/task/governance workflow text changes, update the seeded templates too.

Generated state under `.harness/` is local-only and must not be committed.
