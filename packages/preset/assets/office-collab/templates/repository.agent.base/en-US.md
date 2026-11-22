# Harness Agent Entry

This document defines workspace operating rules for collaborative knowledge work managed through Harness.

## Context Loading

- Load context on demand; read `task_plan.md` and explicitly linked upstream briefs, decisions, and facts first.
- Run `ha settings read` when verifying workspace governance defaults.

## Ownership Discipline

- Acquire the task execution lease before modifying task deliverables.
- Preserve unrelated task packages and clearly report any unverified assumptions.

## Ledger Workflow

- **Facts** capture verifiable observations and baseline measurements with explicit sources.
- **Decisions** record binding choices, trade-offs, and rejected alternatives.
- **Tasks** produce bounded, verifiable deliverables or handoff packages derived from decisions or initiatives.

## Relation Rules

- Use canonical IDs to express causal links (`derives`, `evidenced-by`, `depends-on`, `relates`).

## Write Coordination

- Lifecycle transitions, leases, and relations go through `ha` commands.
- Task prose and structured artifacts synchronize through doc-sync before task submission.
