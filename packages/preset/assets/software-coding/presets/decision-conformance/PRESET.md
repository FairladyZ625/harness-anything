---
schema: preset-document/v1
description: Require implementation work to identify and prove conformance with the accepted decisions that govern it.
whenToUse: Use when a change is constrained by recorded architecture, policy, product, or migration decisions.
---

# Decision Conformance

This package selects the decision-conformance checker profile and declares its typed builtin vertical script. A conformance result exists only when an explicit script command returns a typed receipt; selecting this preset alone never fabricates a verdict.

## Workflow

1. Discover the accepted product, architecture, policy, and migration decisions that govern the change through canonical decision views.
2. Map each applicable requirement to the implementation surface and record concrete evidence of conformance, deviation, or non-applicability in the task.
3. Treat unresolved conflicts, missing accepted authority, and load-bearing draft decisions as blockers instead of silently choosing a side.
4. When proposing a new decision, follow `harness/governance/standards/decision-writing.md`; keep the judgment directly answerable, rationale in the decision body, and implementation requirements in tasks.
5. Run `ha script run vertical:software-coding:decision-conformance --task <task-id> --dry-run` to inspect the deterministic report, then invoke the same declared action without `--dry-run` when a command receipt is required.
6. Use normal task review and completion gates for acceptance; the script report supplements rather than replaces their canonical witnesses.

## Done when

- Applicable accepted decisions and their concrete evidence are visible in the task.
- Deviations and unresolved authority are explicit, with no invented checker receipt.
- Any claimed automated check is backed by the typed `vertical-script-result/v1` command receipt.
