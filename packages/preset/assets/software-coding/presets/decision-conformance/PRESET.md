---
schema: preset-document/v1
description: Require implementation work to identify and prove conformance with the accepted decisions that govern it.
whenToUse: Use when a change is constrained by recorded architecture, policy, product, or migration decisions.
---

# Decision Conformance

This package selects the decision-conformance checker profile for discovery and inspection. It does not claim that a checker script ran or fabricate a conformance verdict.

## Workflow

1. Discover the accepted product, architecture, policy, and migration decisions that govern the change through canonical decision views.
2. Map each applicable requirement to the implementation surface and record concrete evidence of conformance, deviation, or non-applicability in the task.
3. Treat unresolved conflicts, missing accepted authority, and load-bearing draft decisions as blockers instead of silently choosing a side.
4. When proposing a new decision, follow `harness/governance/standards/decision-writing.md`; keep the judgment directly answerable, rationale in the decision body, and implementation requirements in tasks.
5. Use normal task review and completion gates for acceptance. Do not report automated decision-conformance execution until the typed script host exists.

## Done when

- Applicable accepted decisions and their concrete evidence are visible in the task.
- Deviations and unresolved authority are explicit, with no invented checker receipt.
