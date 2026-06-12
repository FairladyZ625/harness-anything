# Minimal Project Example

This example shows the smallest shared-repository Harness loop. Run the commands from an empty Git working directory after installing the CLI package.

```bash
harness-anything --json init
harness-anything --json new-task --title "Wire first M1 task"
harness-anything --json status
harness-anything --json check --post-merge
```

Expected results:

- `init` creates `harness/harness.yaml`, `harness/standards/repo-governance.md`, root agent entry files, and `.gitignore`.
- `new-task` creates a task package under `harness/planning/tasks/task_<ULID>-wire-first-m1-task/`.
- `status` returns `report.schema: "harness-check-report/v1"` and `summary.taskCount: 1`.
- `check --post-merge` returns three axes: `source-package`, `generated-cache`, and `collaboration-gate`.

Commit authored files under `harness/`. Do not commit `.harness/`; it is generated local state.
