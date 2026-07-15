---
schema: preset-document/v1
description: Verify milestone criteria, constituent tasks, decisions, and evidence before declaring the milestone closed.
whenToUse: Use at milestone wrap-up when completion claims must be checked against the milestone boundary.
inputs:
  milestoneCriteriaRoots: Location of milestone criteria and map documents.
  milestoneRootTaskId: Root task whose milestone is being closed.
entrypoints:
  check: ha preset run milestone-closeout check --task <task-id> --allow-scripts
---

# Milestone Closeout

Runs milestone-specific parity and boundary checks and records the result in the closeout task package.
