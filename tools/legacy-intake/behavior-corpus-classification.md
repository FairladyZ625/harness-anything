# Behavior Corpus Classification

M2 Legacy Intake readiness uses this report as the human-readable mirror of the
machine-checkable behavior corpus. Migration intake is represented by explicit
Legacy Intake evidence files; the public package and CLI surface stay on the
Harness-Anything implementation.

Machine-checkable source: `behavior-corpus-classification.json`.

| Classification | Count | Notes |
| --- | ---: | --- |
| preserve | 7 | Core task package, lifecycle, projection, external-binding, and attribution behavior is preserved. |
| intentional-change | 5 | Package identity, CLI bin, private release state, old-runtime blocking, and explicit migration evidence are intentional changes. |
| old-bug | 1 | Broad old-compatibility promises are treated as a bug because they hid unsupported behavior. |
| unsupported-input | 2 | Conflicting legacy trees and npm registry publishing are outside M2 automatic cutover. |
| needs-decision | 0 | No unclassified behavior differences remain. |

## Classified Items

### Preserve

- Local task packages remain authored Markdown under `harness/planning/tasks`.
- Local lifecycle writes continue to go through the `WriteCoordinator` journal before authored files are mutated.
- Generated task IDs remain the default identity policy; manual IDs stay limited to controlled migration mode.
- Six-state lifecycle vocabulary remains `planned`, `active`, `blocked`, `in_review`, `done`, and `cancelled`.
- External engine bindings remain immutable local references rather than agent-owned external status writes.
- SQLite projection is rebuildable generated cache, not the source of task truth.
- `createdBy` remains optional audit metadata sourced from local Git user configuration when available.

### Intentional Change

- Root package identity uses `harness-anything` rather than the previous repository-level product name.
- CLI package identity uses `@harness-anything/cli` and exposes the `harness-anything` binary.
- Package release remains private and `not-published` during M2 Legacy Intake readiness.
- The retired SR implementation route is blocked from production source and public docs.
- Migration is explicit evidence through `migrate-run` and `migrate-verify` rather than automatic legacy compatibility.

### Old Bug

- Old broad public compatibility promises are rejected because they hid unsupported legacy behavior.

### Unsupported Input

- Malformed or conflicting legacy task trees require migration preflight failure rather than best-effort conversion.
- npm registry scope reservation and public publishing are outside M2 and remain deferred release work.

## Legacy Intake Evidence Notes

- Default package identity is `harness-anything`.
- CLI package identity is `@harness-anything/cli`.
- The default CLI package artifact bin is `harness-anything`; external npm publish is intentionally out of scope.
- Retired old runtime paths are blocked by `harness:check-legacy-intake-readiness`.
- Legacy Intake verification is active through `legacy verify`.
- The retired `migrate-verify --full-cutover` flag is covered as a rejection path, not as an active future gate.
- Real repository Legacy Intake smoke is covered by `harness:smoke-legacy-intake`.
- Package artifact executability is verified by `harness:smoke-cli-package`, which builds, packs, installs into a temporary consumer, and runs `harness-anything --json gui` with GUI dry-run enabled.
