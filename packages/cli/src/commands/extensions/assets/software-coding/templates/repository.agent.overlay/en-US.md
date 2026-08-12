## Harness CLI (software/coding)

- Invoke via `ha <command>` or `npx harness-anything <command>`. Create replay tasks with `ha task create --title "<title>"` and repeat `--completion-gate <gate-id>` for the task's declared gate set; never hand-scaffold directories under the tasks root.
- Choose the preset before creating a task. Use `standard-task` for ordinary implementation or document repair, `long-running-task` for extended work, `module` for module scaffolding, `subtask-expansion` to fan out a parent task, `github-issue-repair` for issue intake, `legacy-migration` for legacy migration, and `create-milestone`, `milestone-closeout`, `milestone-dossier`, or `decision-conformance` for their matching workflow. If unsure, run `ha preset list`; do not default everything to `standard-task`.
- Prefer command self-description before composing writes: `ha <command> --help`, preset manifests, and capabilities metadata. When a command supports JSON / `--from-file`, use structured input instead of shell-escaped long text; when it does not, use the current flags.
- Execution lifecycle: run `ha task start <id> --execution-id <exe-id> --json`; its lease binds the authenticated actor, execution id, and lease version. Submit with `ha task submit <id> --execution-id <exe-id> --claim "..." --commit-sha <sha>` plus repeatable `--deliverable`, `--evidence-ref`, `--verification`, `--known-gap`, and `--residual-risk` values. A different reviewer records the required anti-entropy and acceptance reviews with `ha task review-execution`. Complete with `ha task complete <id> --execution-id <exe-id>` and exactly one `--gate-receipt <gate-id>:<receipt-ref>` per gate declared at creation; tasks with an empty gate set need none. Facts are optional `0..N` promotions, never a quantity gate (dec_mrg3z1we/CH1, CH4; ADR-0027 D3, D5-D7).
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
