## Harness CLI (software/coding)

- **General Software Engineering Principles**:
  1. **Verification-First / TDD**: When fixing bugs, first write or identify a reproducing test (observe red), then implement until green; when adding features, write targeted tests and never ship unverified code.
  2. **Minimal Blast Radius**: Choose the simplest implementation satisfying current requirements; avoid speculative abstractions and unneeded configurations; fewer lines of code with equal correctness is always preferred, and deletions count equally to additions.
  3. **Zero Unintended Regressions**: Restrict modifications to paths directly required by the task, preserving existing project functionality and existing tests.
- **The Software Delivery Golden Path**:
  1. **Create Task**: `ha task create --title "..."` to define scope, goals, and acceptance criteria;
  2. **Acquire Lease**: `ha task start <task-id>` to acquire an exclusive Lease, protecting execution and avoiding concurrent collisions;
  3. **Implement & Ground Truth**: Implement code and tests in an isolated environment; use `ha fact record --statement "..." --source "..." --task <task-id>` to capture key test evidence;
  4. **Closeout Synthesis**: Fully author `closeout.md` with Summary, Verification, Residual Risk, and Same Mechanism Elsewhere. In the last section, state the underlying mechanism, where you searched for it, and what you found. **Critical: execution records assimilate directly from closeout.md**; never update artifacts while leaving closeout stale;
  5. **Submit & Independent Review**: `ha task submit <task-id>` submits deliverables; an independent reviewer verifies code and test evidence against ground truth (self-review is rejected with `actor_unauthorized`); settle after completion gates pass via `ha task complete <task-id>`;
  6. **Dynamic Inspection**: The CLI is fully self-describing; always run `ha <command> --help` or `ha capabilities` to verify current grammar, and never memorize static command sequences.

## Repository Scaffolds

Repository Harness layout and responsibilities:
- `harness/harness.yaml`: Repository governance configuration baseline.
- `harness/tasks/`: Task packages collection. Each package manages its own `task_plan.md`, `closeout.md`, and artifacts.
- `harness/decisions/`: Architectural and design decision ledger (recording context, choices, rejected alternatives, and evidence).
- `harness/facts/`: Objective evidence ledger (immutable records of ground-truth measurements).
- `harness/context/`: Long-term project knowledge (`architecture/`, `development/`, `integrations/`, `research/`).
- `harness/governance/standards/`: Team and project engineering standards.
- Read each directory's own README; do not duplicate rules here.

## Architecture-aware Changes

- Before large-scale refactoring or exploration, check architectural guidance under `harness/context/architecture/`.
- Respect declared layering boundaries and dependency directions; do not violate architectural contracts or fabricate unnecessary layers.

## Governance Routing

Follow project governance standards during delivery and collaboration:
- Repository change and branch management: follow `harness/governance/standards/repository-governance.md` and repository conventions.
- Technical decisions: follow `harness/governance/standards/decision-writing.md`, documenting Why and Why-Not.
- Team-specific standards: consult documents under `harness/governance/standards/` or the project root README.

## Script Discovery

- Use `ha script list` and `ha script inspect <id>` to inspect declared automation scripts.
- Run scripts only when inspection explicitly reports execution as available.
