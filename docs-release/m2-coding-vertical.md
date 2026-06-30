# M2 Coding Vertical

Status: M2 complete, package release deferred; the former `--full-cutover` flag is retired historical evidence only

## Install From This Repository

Use Node.js 24 or newer.

```bash
npm ci
npm run typecheck
```

Run the CLI directly during development:

```bash
node packages/cli/src/index.ts --json doctor
```

The package artifact smoke test builds and installs the private CLI package into
a temporary consumer project:

```bash
npm run harness:smoke-cli-package
```

## Doctor

`harness-anything doctor --json` returns `harness-doctor/v1`.

It checks:

- Node.js major version.
- Whether the current directory is inside a Git worktree.
- Whether authored `harness/` state exists.
- Whether local `.harness/` state and projection cache exist.
- Recommended next commands.

Doctor is read-only. It does not create `.harness/`, edit authored task
packages, run repair commands, or call external services.

## Minimal Project Loop

```bash
harness-anything init --json
harness-anything doctor --json
harness-anything new-task --title "Plan the work" --json
harness-anything status --json
harness-anything check --post-merge --json
```

For coding vertical dogfood, create new work through the vertical/preset surface:

```bash
harness-anything new-task --title "Implement slice" --vertical software/coding --preset standard-task --json
harness-anything new-task --title "Implement module slice" --vertical software/coding --preset module --module billing --json
```

Project defaults can provide the same coding vertical and preset choices, but
the explicit flags above are the portable command surface for agents and tests.

Complete ordinary work through the terminal closeout command after review, CI,
and local checks are ready:

```bash
harness-anything task-complete <task-id> --ci passed --reviewer <reviewer-id> --json
```

Task package commands:

```bash
harness-anything task progress append <task-id> --text "Implemented first slice" --json
harness-anything task archive <task-id> --reason "superseded" --json
harness-anything task supersede <task-id> --title "Replacement task" --reason "scope changed" --json
```

## Legacy Intake And Evidence Commands

Read-only or local-only evidence commands:

```bash
harness-anything snapshot multica <ref> --json
harness-anything adopt multica <ref> --task <task-id> --json
harness-anything migrate-plan --json
harness-anything migrate-structure --plan --json
harness-anything migrate-run --plan-only --json
harness-anything migrate-verify <session.json> --json
harness-anything git-diff --json
```

M2 shipped migration evidence commands, but the project strategy changed after
M2: future releases should treat old task packages as legacy evidence, not as
input for automatic task-package conversion. Use Legacy Intake and rebuild
unfinished work as new tasks with provenance:

```bash
harness-anything legacy scan <legacy-root> --json
harness-anything legacy copy-safe-docs <legacy-root> --apply --json
harness-anything legacy index <legacy-root> --apply --json
harness-anything legacy verify --json
harness-anything new-task --from-legacy <legacy-id> --json
```

`createdBy` is optional task audit metadata sourced from local Git
`user.name`/`user.email` when available. It is not task status, package
disposition, or review state.

`git-diff` is local read-only evidence. It does not replace Git as the source of
truth and does not write task state.

## Troubleshooting

If `doctor` reports no authored harness root, run:

```bash
harness-anything init --json
```

If `status` or `check` reports generated-cache warnings, rebuild generated
state instead of editing SQLite or journal files:

```bash
harness-anything governance rebuild --json
harness-anything check --post-merge --json
```

If authored task packages have hard-fail issues, fix the markdown package and
run the check again:

```bash
harness-anything check --post-merge --json
```

## Historical Final Cutover Evidence

M2-P7 used `migrate-verify --full-cutover` as historical completion evidence.
That strategy is now deprecated. Future work should not use full cutover as an
exit gate or dogfood prerequisite.

Historical M2 evidence used the now-retired full-cutover flag:

```bash
harness-anything migrate-run --json
harness-anything migrate-verify <session.json> --full-cutover --json
```

Current M2.5 replacements are:

```bash
npm run harness:check-legacy-intake-readiness
npm run harness:smoke-legacy-intake
npm run check
```

M2.5 replaces the active gate names with Legacy Intake readiness and smoke checks.

Package release decision:

- no npm publish in M2.
- packages remain `private: true`.
- workspace versions remain `0.0.0`.
- no `publishConfig` is introduced.

M2 completion does not claim npm registry ownership, GUI completion, external
write adapters, or later roadmap milestones.
