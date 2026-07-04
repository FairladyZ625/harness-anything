# Harness Agent Entry

Read `harness/harness.yaml` and `harness/standards/repo-governance.md` before changing task state.

## Harness CLI

- Invoke via `ha <command>` or `npx harness-anything <command>`. Create task packages with `new-task`; never hand-scaffold directories under the tasks root.
- Choose the preset before creating a task. Use `standard-task` for ordinary implementation or document repair, `milestone-closeout` for milestone closeout, `legacy-migration` for legacy migration, `module` for module scaffolding, `long-running-task` for long-running work, `lesson-sedimentation` for lesson capture, `version-upgrade` for version upgrades, and `publish-standard` / `release-closeout` for release work. If operating docs lag active decisions or ADRs, use `doc-canon-sync` and run `ha preset action doc-canon-sync check --task <id> --allow-scripts` to produce `artifacts/doc-canon-drift.json`. If unsure, run `ha preset list`; do not default everything to `standard-task`.
- Prefer command self-description before composing writes: `ha <command> --help`, preset manifests, and capabilities metadata. When a command supports JSON / `--from-file`, use structured input instead of shell-escaped long text; when it does not, use the current flags. During command-renaming transition, document the current runnable name and treat old aliases as compatibility only.
- Task progress: `ha task status set <id> active`, then `ha task progress append <id> --text "<note>" --evidence type:PATH:summary`. Progress is a timeline, not a fact ledger.
- Fact gate: every task that reaches review/complete must have at least one real fact. Record load-bearing observations with `ha record fact --task <id> --statement "<verifiable observation>" --source "<source>" --confidence high`.
- Review and completion: `ha task-review <id>`, then `ha task-complete <id> --ci passed|failed`. These commands produce a task verdict (PASS/FAIL). Missing facts, placeholder review, or placeholder closeout fail closed.
- Decisions: route choices, reversals, long-lived boundaries, and choices that derive follow-up work use `ha decision propose --title ... --question ... --chosen ... --rejected ... --why-not ...`. A verdict is not a decision unless it exposes a strategic question.
- Relations: connect supporting facts and downstream decisions/tasks with `ha decision relate <id> --anchor <CH1|C1|RJ1> --type supports|supersedes|refines|narrows|relates --target <entity-ref> --rationale "..."`. Isolated entities are audit findings.
- Query through projections: `ha decision list --state active --module <key> --compact`, `ha decision show <id|E<n>>`, and `ha task list --module <key>`.
- Disposition: do not physically delete decisions; supersede or retire them. Facts are append-only; invalidate stale facts instead of rewriting them. Check relation cascade impact before deleting or archiving anything.
- Writes that go through the harness CLI are auto-committed when the harness root is inside a git repository, with semantic messages such as `task(progress-append): <id>` or `decision(relate): <id>`. Do not add a second commit for coordinator-owned writes. Hand-edited prose still needs a normal commit.
- Boundary: machine-read fields and relations must be written through CLI commands. Human-read prose may be edited directly, but it does not replace facts, decisions, or relations.
- Template assets are part of the operating surface. When AGENTS/task/governance workflow text changes, update the seeded templates too so new scaffolds do not teach stale behavior.

Generated state under `.harness/` is local-only and must not be committed.
