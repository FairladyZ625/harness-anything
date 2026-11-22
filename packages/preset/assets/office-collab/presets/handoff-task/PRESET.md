---
schema: preset-document/v1
description: Create a formal cross-owner handoff package with deterministic four-element completeness verification.
whenToUse: Transferring ownership of an initiative, workstream, or recurring responsibility between people or teams.
---

# Handoff Task

Formal `office/collab` handoff preset verifying the four handoff elements (`ownerTransfer`, `deliverables`, `openItems`, `acceptanceCriteria`) against frozen task artifacts.

## Profiles

- `baseline`: Enforces `handoff-completeness` on `artifacts/handoff.json` and every listed deliverable artifact's SHA-256 digest.
- `fresh` (`--profile fresh`): Enforces both `handoff-completeness` and `upstream-fresh`.
- `lightweight` (`--profile lightweight`): Minimal plan, handoff notes (`handoff.md`), and closeout without completion gates.
