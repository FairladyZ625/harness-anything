# Harness Agent Entry

This entry holds stable operating rules only. Current milestone context, roadmap state, and task-specific background belong in the active task package, not in AGENTS.md.

## Context loading

- Read `harness/harness.yaml`.
- If a task is assigned, read that task package first: `task_plan.md` and any files explicitly named there.
- Route from the task to the smallest relevant standard or folder README. Do not preload the full ADR, decision, milestone, or standards tree.

## Worktree discipline

- Background/parallel workers, and any public implementation or public docs PR, start from latest `origin/main` in `.worktrees/<slug>` on branch `codex/<slug>`.
- Do not edit `packages/**`, `tools/**`, `docs-release/**`, or root public config from the shared repository root. Keep the shared root for coordination, private harness writes, local ignored entry files, and final sync.
- Leave unrelated dirty files in their original checkout. After merge, delete the remote PR branch, clean the local worktree/branch, and record any residual cleanup.

## Kernel Workflow (triadic)

- `task` is the work unit and status timeline.
- `fact` is a task-local, append-only, explicit `0..N` promotion of a load-bearing observation. Delivery evidence belongs in Execution outputs; review and completion impose no Fact quantity gate.
- `decision` is the load-bearing why: choices, reversals, long-lived boundaries, and downstream work-spawning judgments.
- Prose mentions do not replace facts, decisions, or relations.

## Relation edge rules

- Write relations with canonical ids. Legacy `E<n>` selectors are projection-read conveniences for commands such as `ha decision show`; do not assume write commands accept them.
- Decision-to-task edges use `derives` when the decision spawned the task and `relates` when the task was later found connected.
- `refines` is for decision-to-decision revision, not for target `task/...`.

## WriteCoordinator discipline

- Writes through the harness CLI are auto-committed when the harness root is inside a Git repository. Do not add a second commit for coordinator-owned writes.
- For registered hand-edited task prose, run `ha doc status`, preview with `ha doc sync --dry-run`, then submit only owned paths with repeatable `ha doc sync --submit --path <authored-relative-path>`. The daemon validates zones and creates the attributed commit; do not add a second raw Git commit.
- Top-level ADR, standard, template, and repository-agent prose stays on its existing governed repository path until the write-road registry explicitly classifies it for doc sync; unknown Markdown fails closed.
- Public source and release-document files outside the authored harness remain on the normal code-PR Git path: inspect `git status --short`, stage only task-owned paths, and leave unrelated dirty files alone.
- Machine-read fields and relations must be written through CLI commands. Human-read prose may be edited directly, but it does not create graph state.

Generated state under `.harness/` is local-only and must not be committed.
