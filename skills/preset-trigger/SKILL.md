---
name: preset-trigger
description: Start Harness Anything task creation by choosing a software/coding preset first. Use when creating or planning a harness task package.
---

# Preset Trigger

## Core Rule

When building a Harness Anything task, choose the preset before creating the task package. Presets are the recommended starting points for task shape, checks, and generated materials.

Use:

```bash
ha task create --title "<title>" --vertical software/coding --preset <id>
```

If unsure, inspect the current list first:

```bash
ha task create --help
ha preset list
ha capabilities preset
```

## Organize Work

A **work** is the only grouping concept: one root task plus the tasks filed under it (its `parentTaskId` subtree). When several tasks serve one goal, group them in a work instead of leaving them flat.

```bash
ha work create --title "<work name>"                      # root task on the create-work preset
ha task create --work <work-id> --title "<title>" --preset <id>
ha work list                                              # open works; --all includes closed ones
ha work show <work-id>                                    # goal, subtree counts, open tasks
ha agenda --work <work-id>                                # the agenda narrowed to one work
```

- Without `--work`, a task stands alone. The create receipt names the task's work, or hints `--work` when open works exist; read that hint before filing the next task.
- `--work` accepts the work root or any task inside the work; the new task becomes that task's child. `ha task list --parent <id> --depth all` reads the whole subtree.
- Close a work with the `work-closeout` preset before completing its root task.

## Available Presets

- `architecture-rot-audit`: Detect structural architecture drift.
- `code-impact-analysis`: Map a proposed change across code, tests, docs, dependencies, and operations.
- `create-work`: The root of a work; its `task_plan.md` is the work map. Start it with `ha work create --title "<name>"`.
- `decision-conformance`: Prove implementation alignment with accepted decisions.
- `docs-task`: Plan design, documentation, or chore work without a code commit.
- `github-issue-repair`: Repair an existing GitHub issue with evidence.
- `legacy-migration`: Run generation replay of a previous-generation Harness repository, resolve reported conflicts, and rebuild legacy presets as v3 packages.
- `standard-task`: General implementation or maintenance task; the default starting point.
- `subtask-expansion`: Plan and fan out a parent task into concrete child tasks, each created with `--work <parent-id>`.
- `work-closeout`: Verify a work's criteria, tasks, decisions, and evidence before declaring it closed.
- `worker-dispatch`: Add bounded worker coordination roles and dependencies.

## Guardrails

- Do not hand-create task package directories.
- Do not skip preset selection for software/coding work; use `standard-task` when no narrower preset fits.
- Use `legacy-migration` only for `ha migrate import` generation replay; do not turn it into manual legacy-material classification.
- Do not edit task markdown directly when a `ha task create` path is available.
- Group tasks only through works. There is no module, milestone, or epic grouping; do not invent one in task titles or directories.
