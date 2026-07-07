## Harness CLI (software/coding)

- Invoke via `ha <command>` or `npx harness-anything <command>`. Create task packages with `ha task create --title "<title>"`; never hand-scaffold directories under the tasks root.
- Choose the preset before creating a task. Use `create-milestone` for milestone root creation, `standard-task` for ordinary implementation or document repair, `milestone-closeout` for milestone closeout, `legacy-migration` for legacy migration, `module` for module scaffolding, `long-running-task` for long-running work, `lesson-sedimentation` for lesson capture, `version-upgrade` for version upgrades, and `publish-standard` / `release-closeout` for release work. If operating docs lag active decisions or ADRs, use `doc-canon-sync` and run `ha preset action doc-canon-sync check --task <id> --allow-scripts` to produce `artifacts/doc-canon-drift.json`. If unsure, run `ha preset list`; do not default everything to `standard-task`.
- Prefer command self-description before composing writes: `ha <command> --help`, preset manifests, and capabilities metadata. When a command supports JSON / `--from-file`, use structured input instead of shell-escaped long text; when it does not, use the current flags.
- Review and completion: move the task into review with `ha task transition <id> in_review`, replace placeholder review/closeout content with real evidence, run `ha task review <id>`, then `ha task complete <id> --ci passed|failed`. Missing facts, placeholder review, or placeholder closeout fail closed.
- Query through projections: `ha decision list --state active --module <key> --compact`, `ha decision show <id|E<n>>`, and `ha task list --module <key>`.
- Non-coordinator write closeout: after manually editing docs, standards, templates, artifact indexes, or source files, check `git status --short` in the affected repository and commit only paths touched in the task. Do not include unrelated dirty files. If a manual edit is intentionally not committed, record the owner and no-commit reason.
- Template assets are part of the operating surface. When AGENTS/task/governance workflow text changes, update the seeded templates too so new scaffolds do not teach stale behavior.

## Scaffold folders (see each folder README, do not duplicate here)

Each scaffold folder owns the single source of truth for its own usage. This entry only routes; it never restates folder rules (anti-drift, ADR-0021 D3):

- ADR discipline → `harness/adr/README.md`
- Decision discipline → `harness/decisions/README.md`
- Milestone discipline → `harness/milestones/README.md`
- Sessions, standards, and context → `harness/sessions/README.md`, `harness/standards/README.md`, `harness/context/README.md`

## Governance routing (near-field hard gates)

- PR / branch / merge / admin bypass → `harness/standards/repo-governance.md` and `.github/pull_request_template.md`
- CI / required checks / release gates → `harness/standards/ci-cd-standard.md`
- Testing tier / evidence depth / new test files → `harness/standards/testing-standard.md`

## CI/Gate authority stop condition

- If the current task is not a CI/gate/governance task but requires modifying CI/gate authority surfaces to pass, stop implementation, record the blocker, and request or create a governance task.
- Authorized exceptions are explicit CI/gate/governance tasks and break-glass main recovery. Break-glass must record reason, scope, and the follow-up governance task in the PR body.
