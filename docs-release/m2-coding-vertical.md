# M2 Coding Vertical

Status: M2 final-cutover evidence complete, package release deferred

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

`harness doctor --json` returns `harness-doctor/v1`.

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
harness init --json
harness doctor --json
harness new-task --title "Plan the work" --json
harness status --json
harness check --post-merge --json
```

Task package commands:

```bash
harness task progress append <task-id> --text "Implemented first slice" --json
harness task archive <task-id> --reason "superseded" --json
harness task supersede <task-id> --title "Replacement task" --reason "scope changed" --json
```

## Migration And Evidence Commands

Read-only or local-only evidence commands:

```bash
harness snapshot multica <ref> --json
harness adopt multica <ref> --task <task-id> --json
harness migrate-plan --json
harness migrate-structure --plan --json
harness migrate-run --plan-only --json
harness migrate-verify <session.json> --json
harness migrate-verify <session.json> --full-cutover --json
harness git-diff --json
```

`createdBy` is optional task audit metadata sourced from local Git
`user.name`/`user.email` when available. It is not task status, package
disposition, or review state.

`git-diff` is local read-only evidence. It does not replace Git as the source of
truth and does not write task state.

## Troubleshooting

If `doctor` reports no authored harness root, run:

```bash
harness init --json
```

If `status` or `check` reports generated-cache warnings, rebuild generated
state instead of editing SQLite or journal files:

```bash
harness governance rebuild --json
harness check --post-merge --json
```

If authored task packages have hard-fail issues, fix the markdown package and
run the check again:

```bash
harness check --post-merge --json
```

## Final Cutover Evidence

M2-P7 activates `migrate-verify --full-cutover` as the final repository gate.
The gate verifies the migration session, package release decision, package
surface, and behavior corpus report before returning success.
The behavior corpus must contain at least 15 classified items and zero
`needs-decision` entries.

Local final-cutover checks:

```bash
harness migrate-run --json
harness migrate-verify <session.json> --full-cutover --json
npm run harness:check-cutover-readiness
npm run harness:smoke-full-cutover
npm run check
```

Package release decision:

- no npm publish in M2.
- packages remain `private: true`.
- workspace versions remain `0.0.0`.
- no `publishConfig` is introduced.

M2 completion does not claim npm registry ownership, GUI completion, external
write adapters, or later roadmap milestones.
