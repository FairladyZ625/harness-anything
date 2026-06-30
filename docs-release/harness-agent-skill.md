# Harness Agent Skill

Status: M2.5 usable workflow

## Rules

1. Read `harness/harness.yaml` and the task `INDEX.md` before changing task state.
2. Local task state is owned by Harness commands. Use `harness-anything task progress append`, `harness-anything task archive`, `harness-anything task supersede`, `harness-anything task delete`, `harness-anything task reopen`, and `harness-anything task-complete`.
3. External engine task state is read-only in Harness. Change status in the owning engine, then use `harness-anything check` locally.
4. Do not edit `task_id`, `lifecycle.binding*`, or generated `.harness/` files by hand.
5. Use `harness-anything task supersede` for follow-up work after `done` or `cancelled`; do not reopen terminal work.
6. Use `harness-anything task delete --soft` for audit-preserving removal. `--hard` is only for mistaken local packages with no archive, terminal status, or task relations.
7. Run `harness-anything status --json` and `harness-anything check --post-merge` after merges before continuing authored task changes.
8. Use `harness-anything doctor --json` before starting work in a checkout or after installing the CLI package artifact. Treat it as diagnostic evidence only; it does not repair files.
9. Use `harness-anything git-diff --json` when a task needs local diff evidence. It is read-only and reports relative paths.

## Standard Work Loop

```bash
harness-anything doctor --json
harness-anything status --json
harness-anything check --post-merge --json
```

For new local work:

```bash
harness-anything new-task --title "Task title" --vertical software/coding --preset standard-task --json
harness-anything task progress append <task-id> --text "Progress note" --json
harness-anything task-complete <task-id> --ci passed --reviewer <reviewer-id> --json
```

For module-scoped coding work:

```bash
harness-anything new-task --title "Module task" --vertical software/coding --preset module --module <module-key> --json
```

For unfinished legacy work, keep the legacy state as evidence and rebuild a new
Harness task with provenance:

```bash
harness-anything legacy scan <legacy-root> --json
harness-anything legacy copy-safe-docs <legacy-root> --apply --json
harness-anything legacy index <legacy-root> --apply --json
harness-anything legacy verify --json
harness-anything new-task --from-legacy <legacy-id> --json
```

For external read-only adoption:

```bash
harness-anything snapshot multica <ref> --json
harness-anything adopt multica <ref> --task <task-id> --json
harness-anything check --post-merge --json
```

See `docs-release/m1-minimal-loop.md` for the repository model, state machine,
and check report axes. See `docs-release/m2-coding-vertical.md` for install,
doctor, migration, and troubleshooting notes.
