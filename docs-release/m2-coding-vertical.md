# M2 Coding Vertical

Status: M2 complete, package release deferred; final-cutover evidence is historical and deprecated for future strategy

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

## Legacy Intake And Evidence Commands

Read-only or local-only evidence commands:

```bash
harness snapshot multica <ref> --json
harness adopt multica <ref> --task <task-id> --json
harness migrate-plan --json
harness migrate-structure --plan --json
harness migrate-run --plan-only --json
harness migrate-verify <session.json> --json
harness git-diff --json
```

M2 shipped migration evidence commands, but the project strategy changed after
M2: future releases should treat old task packages as legacy evidence, not as
input for automatic task-package conversion. Use Legacy Intake and rebuild
unfinished work as new tasks with provenance.

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

## Historical Final Cutover Evidence

M2-P7 used `migrate-verify --full-cutover` as historical completion evidence.
That strategy is now deprecated. Future work should not use full cutover as an
exit gate or dogfood prerequisite.

Historical M2 evidence used the now-retired full-cutover flag:

```bash
harness migrate-run --json
harness migrate-verify <session.json> --full-cutover --json
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
