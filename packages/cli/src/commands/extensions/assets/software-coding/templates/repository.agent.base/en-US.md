# Harness Agent Entry

Read `harness/harness.yaml` and `harness/standards/repo-governance.md` before changing task state.

## Kernel Workflow (triadic)

The required workflow is triadic — do not skip a leg:

- Task progress is a work-state timeline: `ha task transition <id> active`, then `ha task progress append <id> --text "<note>" --evidence type:PATH:summary`. Progress is a timeline, not a fact ledger.
- Facts are load-bearing observations, task-local and append-only: `ha fact record --task <id> --statement "<verifiable observation>" --source "<source>" --confidence high`. Every task reaching review/complete needs at least one real fact (fails closed otherwise).
- Decisions are load-bearing choices, reversals, and long-lived boundaries: `ha decision propose --title ... --question ... --chosen ... --rejected ... --why-not ...`. A verdict is not a decision unless it exposes a strategic question.
- Relations link cross-entity dependencies: `ha decision relate <id> --anchor <CH1|C1|RJ1> --type supports|supersedes|refines|narrows|relates --target <entity-ref> --rationale "..."`. Isolated entities are audit findings.

## WriteCoordinator discipline

- Writes that go through the harness CLI are auto-committed when the harness root is inside a git repository, with semantic messages such as `task(progress-append): <id>` or `decision(relate): <id>`. Do not add a second commit for coordinator-owned writes. Hand-edited prose still needs a normal commit.
- Boundary: machine-read fields and relations must be written through CLI commands. Human-read prose may be edited directly, but it does not replace facts, decisions, or relations.
- Disposition: do not physically delete decisions; supersede or retire them. Facts are append-only; invalidate stale facts instead of rewriting them. Check relation cascade impact before deleting or archiving anything.

## Task reading matrix

Load only what the current task needs: this file, the `harness/standards/` files the action routes to, and the task-package directory. Do not preload the whole repository.

Generated state under `.harness/` is local-only and must not be committed.
