# Harness Agent Entry

This document defines repository operating rules and the system ontology. In this repository, Harness serves as a cognitive ledger engine helping you and human collaborators maintain alignment and track evolutionary progress. Real-world code and tests are the objective reality; Harness records the causal evolution behind them.

## Context Loading

- Load context on demand; avoid preloading the entire codebase or knowledge tree.
- Read `harness/harness.yaml` as the repository governance baseline upon startup.
- When assigned a task, read only `task_plan.md` and the code/context files explicitly referenced, keeping context concise and focused.

## Worktree Discipline

- Maintain workspace isolation: complex feature development or refactoring should happen in isolated branches or worktrees to avoid polluting the main working tree.
- Stage and commit only task-owned paths, preserving unrelated changes.
- Follow declared base branch, merge, cleanup, and publication instructions.

## Kernel Workflow

- **Single Source of Truth vs Read Projections (SSoT)**: The resident daemon's single-writer event stream and SQLite Outbox maintain authoritative state; markdown files under `harness/` are read projections. Always use `ha` semantic commands instead of manually editing machine-read metadata.
- **The Triad Causal Loop in Software Engineering**:
  - **Fact**: Ground truth observations from the objective world. In software engineering, "unmeasured modification is blind guessing": failing test outputs, benchmark numbers, dependency versions, and verified inputs/outputs are Facts. Load-bearing claims must anchor to Facts; default completion gates require at least one real Fact.
  - **Decision**: Irreversible technical choices and architectural trade-offs (why choose Option A over Option B, why introduce a dependency, system boundaries). Load-bearing claims must be grounded in Facts (`evidenced-by`), rejecting arbitrary assumptions.
  - **Task**: The minimal verifiable delivery slice derived from a Decision. Follow verification-first/red-green cycles; task completion must yield new Facts (e.g. passing tests, verified metrics) to close the causal loop.
  - **Causal Spiral**: Objective observation forms a **Fact** → Fact grounds a **Decision** → Decision derives a **Task** → Task produces a new **Fact** to verify hypotheses and establish a new baseline.
- Casual mentions in prose do not replace canonical Facts, Decisions, or Relations.

## Relation Rules

- Use canonical IDs to establish causal links:
  - `derives`: Decision directly spawns a Task;
  - `evidenced-by`: Fact supports a Decision Claim;
  - `relates`: Connection between tasks or artifacts identified later;
  - `refines`: Evolution or amendment from Decision to Decision.

## Write Coordination

- Lifecycle transitions, lease acquisitions, and relations must be written via `ha` commands.
- Long-term repository documentation synchronizes via doc-sync, relative to `harness/`.
- Ephemeral state under `.harness/` is local-only and must not be committed.
