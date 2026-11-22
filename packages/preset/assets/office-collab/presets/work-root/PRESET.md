---
schema: preset-document/v1
description: Create a collaboration work root whose plan coordinates deliverables, handoffs, minutes, and exit criteria.
whenToUse: Use when an office collaboration initiative needs one work root, workstream decomposition, stakeholders, and exit criteria.
---
# Collaboration Work Root

A collaboration work is one root task plus its parent-child subtree of deliverables, handoffs, and meeting minutes, anchored to an in-effect Decision. Create it with `ha work create --title "<name>" --decision <decision-id>`.

## Workflow

1. Confirm or accept the charter decision anchoring the initiative.
2. Create the work root with `ha work create --title "<name>" --decision <decision-id> --plan-file <plan.md>`.
3. Break the work into deliverable, handoff, or minutes tasks using `ha task create --work <root-task-id>`.
4. Track overall status with `ha work show <root-task-id>` and keep upstream baselines and handoffs aligned.

## Done when

- The work root, accepted decision, and work map stay aligned.
- Every workstream has an owner, deliverable contract, and exit criteria.
- All child deliverables and handoffs have completed verification.
