# Harness Agent Entry

This entry holds stable operating rules only. Current milestone context, roadmap state, temporary read sets, and task-specific background belong in the active task package or docmap, not in AGENTS.md.

## Context loading

- Read `harness/harness.yaml`.
- If a task is assigned, read that task package first: `task_plan.md`, `read_set.md`, and any files explicitly named there.
- Route from the task to the smallest relevant standard or folder README. Do not preload the full ADR, decision, milestone, or standards tree.

## Worktree discipline

- Background/parallel workers, and any public implementation or public docs PR, start from latest `origin/main` in `.worktrees/<slug>` on branch `codex/<slug>`.
- Do not edit `packages/**`, `tools/**`, `docs-release/**`, or root public config from the shared repository root. Keep the shared root for coordination, private harness writes, local ignored entry files, and final sync.
- Leave unrelated dirty files in their original checkout. After merge, delete the remote PR branch, clean the local worktree/branch, and record any residual cleanup.

## Kernel Workflow (triadic)

- `task` is the work unit and status timeline.
- `fact` is a task-local, append-only, verifiable observation. Every task reaching review/complete needs at least one real fact.
- `decision` is the load-bearing why: choices, reversals, long-lived boundaries, and downstream work-spawning judgments.
- Prose mentions do not replace facts, decisions, or relations.

## Relation edge rules

- Write relations with canonical ids. Legacy `E<n>` selectors are projection-read conveniences for commands such as `ha decision show`; do not assume write commands accept them.
- Decision-to-task edges use `derives` when the decision spawned the task and `relates` when the task was later found connected.
- `refines` is for decision-to-decision revision, not for target `task/...`.

## WriteCoordinator discipline

- Writes through the harness CLI are auto-committed when the harness root is inside a Git repository. Do not add a second commit for coordinator-owned writes.
- Hand-edited prose, standards, templates, artifact indexes, or source files must be committed by the agent that changed them: check `git status --short`, stage only paths touched in the task, and leave unrelated dirty files alone.
- Machine-read fields and relations must be written through CLI commands. Human-read prose may be edited directly, but it does not create graph state.

Generated state under `.harness/` is local-only and must not be committed.
