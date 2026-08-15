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

- `architecture-rot-audit`: Detect structural architecture drift.
- `code-impact-analysis`: Map a proposed change across code, tests, docs, dependencies, and operations.
- `create-milestone`: Create a milestone root and its durable map.
- `decision-conformance`: Prove implementation alignment with accepted decisions.
- `docs-task`: Plan design, documentation, or chore work without a code commit.
- `github-issue-repair`: Repair an existing GitHub issue with evidence.
- `legacy-migration`: Run generation replay of a previous-generation Harness repository, resolve reported conflicts, and rebuild legacy presets as v3 packages.
- `milestone-closeout`: Verify a milestone before declaring it closed.
- `module`: Module-scoped task with registered module metadata.
- `standard-task`: General implementation or maintenance task; the default starting point.
- `subtask-expansion`: Plan and fan out a parent task into concrete subtasks.
- `worker-dispatch`: Add bounded worker coordination roles and dependencies.

## Guardrails

- Do not hand-create task package directories.
- Do not skip preset selection for software/coding work; use `standard-task` when no narrower preset fits.
- Use `legacy-migration` only for `ha migrate import` generation replay; do not turn it into manual legacy-material classification.
- Do not edit task markdown directly when a `ha task create` path is available.
