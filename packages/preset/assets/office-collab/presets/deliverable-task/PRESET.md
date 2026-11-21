---
schema: preset-document/v1
description: Create a structured collaboration deliverable package with optional deterministic artifact contract and upstream freshness gates.
whenToUse: Cross-role proposals, reports, specifications, briefings, or checklists that require verifiable artifact delivery.
---

# Deliverable Task

Default `office/collab` preset for non-code knowledge-work deliverables.

## Profiles

- `baseline`: Standard task plan, deliverable brief (`deliverable-brief.md`), and closeout scaffold without extra completion gates.
- `verified` (`--profile verified`): Enforces `deliverable-contract` against `artifacts/deliverable-manifest.json` and the referenced deliverable document (SHA-256 integrity and non-empty required sections).
- `upstream-verified` (`--profile upstream-verified`): Enforces both `deliverable-contract` and `upstream-fresh` (`artifacts/upstream-freshness.json` baseline digest freshness check).
- `lightweight` (`--profile lightweight`): Minimal plan and closeout scaffold with automatic archive on completion.
