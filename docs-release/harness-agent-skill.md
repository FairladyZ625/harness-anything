# Harness Agent Skill

Status: initial

## Rules

1. Read `harness/harness.yaml` and the task `INDEX.md` before changing task state.
2. Local task state is owned by Harness commands. Use `harness task status set`, `harness task progress append`, `harness task archive`, `harness task supersede`, `harness task delete`, and `harness task reopen`.
3. External engine task state is read-only in Harness. Change status in the owning engine, then use `harness check` locally.
4. Do not edit `task_id`, `lifecycle.binding*`, or generated `.harness/` files by hand.
5. Use `harness task supersede` for follow-up work after `done` or `cancelled`; do not reopen terminal work.
6. Use `harness task delete --soft` for audit-preserving removal. `--hard` is only for mistaken local packages with no archive, terminal status, or task relations.
7. Run `harness status --json` and `harness check --post-merge` after merges before continuing authored task changes.
