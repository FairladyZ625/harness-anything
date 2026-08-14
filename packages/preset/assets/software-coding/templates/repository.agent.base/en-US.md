# Harness Agent Entry

This file contains stable repository operating rules. Current milestone state and task-specific context belong in the active task package.

## Context Loading

- Read `harness/harness.yaml`.
- When a task is assigned, read its `task_plan.md` and only the files it names.
- Route from the task to the smallest relevant context or standard document; do not preload the whole authored tree.

## Worktree Discipline

- Use an isolated worktree and task branch for implementation work.
- Preserve unrelated changes in every checkout and stage only task-owned paths.
- Follow the task's declared base, merge, cleanup, and publication instructions.

## Kernel Workflow

- A task is the work unit and status timeline.
- A fact is an explicit, append-only promotion of a load-bearing observation; facts are optional `0..N`, not a completion quantity gate.
- A decision records the load-bearing why: choices, reversals, long-lived boundaries, and downstream work-spawning judgments.
- Prose mentions do not replace canonical facts, decisions, or relations.

## Relation Rules

- Write relations with canonical IDs.
- Use `derives` when a decision directly spawned a task and `relates` when a connection was identified later.
- Use `refines` only for decision-to-decision revision.

## Write Coordination

- Use Harness commands for machine-read fields, lifecycle changes, and relations.
- Follow repository doc-sync policy for registered authored prose.
- Generated state under `.harness/` is local-only and must not be committed.
