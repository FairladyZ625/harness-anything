# Harness Agent Skill

Status: M2.5 usable workflow

## Rules

1. Read `harness/harness.yaml` and the task `INDEX.md` before changing task state.
2. Local task state is owned by Harness commands. Use `harness task progress append`, `harness task archive`, `harness task supersede`, `harness task delete`, `harness task reopen`, and `harness task-complete`.
3. External engine task state is read-only in Harness. Change status in the owning engine, then use `harness check` locally.
4. Do not edit `task_id`, `lifecycle.binding*`, or generated `.harness/` files by hand.
5. Use `harness task supersede` for follow-up work after `done` or `cancelled`; do not reopen terminal work.
6. Use `harness task delete --soft` for audit-preserving removal. `--hard` is only for mistaken local packages with no archive, terminal status, or task relations.
7. Run `harness status --json` and `harness check --post-merge` after merges before continuing authored task changes.
8. Use `harness doctor --json` before starting work in a checkout or after installing the CLI package artifact. Treat it as diagnostic evidence only; it does not repair files.
9. Use `harness git-diff --json` when a task needs local diff evidence. It is read-only and reports relative paths.

## Standard Work Loop

```bash
harness doctor --json
harness status --json
harness check --post-merge --json
```

For new local work:

```bash
harness new-task --title "Task title" --vertical software/coding --preset standard-task --json
harness task progress append <task-id> --text "Progress note" --json
harness task-complete <task-id> --ci passed --reviewer <reviewer-id> --json
```

For module-scoped coding work:

```bash
harness new-task --title "Module task" --vertical software/coding --preset module --module <module-key> --json
```

For unfinished legacy work, keep the legacy state as evidence and rebuild a new
Harness task with provenance:

```bash
harness legacy scan <legacy-root> --json
harness legacy copy-safe-docs <legacy-root> --apply --json
harness legacy index <legacy-root> --apply --json
harness legacy verify --json
harness new-task --from-legacy <legacy-id> --json
```

For external read-only adoption:

```bash
harness snapshot multica <ref> --json
harness adopt multica <ref> --task <task-id> --json
harness check --post-merge --json
```

See `docs-release/m1-minimal-loop.md` for the repository model, state machine,
and check report axes. See `docs-release/m2-coding-vertical.md` for install,
doctor, migration, and troubleshooting notes.
