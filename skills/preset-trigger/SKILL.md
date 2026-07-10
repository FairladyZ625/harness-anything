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

## Available Presets

- `standard-task`: General implementation or maintenance task; the default starting point.
- `long-running-task`: Extended task that needs explicit long-running coordination.
- `module`: Module-scoped task with registered module metadata.
- `subtask-expansion`: Plan and fan out a parent task into concrete subtasks.
- `github-issue-repair`: Pull a GitHub issue and prepare an evidence-backed repair plan.
- `legacy-migration`: Legacy task intake or migration planning.
- `create-milestone`: Create a milestone root task, then scaffold and check the milestone map files.
- `decision-conformance`: Work that must prove alignment with recorded decisions.
- `milestone-closeout`: Milestone wrap-up checks and evidence collection.
- `milestone-dossier`: Generate a milestone dossier from project evidence.

## Guardrails

- Do not hand-create task package directories.
- Do not skip preset selection for software/coding work; use `standard-task` when no narrower preset fits.
- Do not edit task markdown directly when a `ha task create` path is available.
