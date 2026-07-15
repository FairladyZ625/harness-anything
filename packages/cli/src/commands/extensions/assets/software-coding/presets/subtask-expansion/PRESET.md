---
schema: preset-document/v1
description: Turn a parent task into a concrete worker plan with explicit roles and dependency ordering.
whenToUse: Use when a bounded parent task is ready to be decomposed into independently executable child responsibilities.
inputs:
  childRoles: Comma-separated worker roles to include in the plan.
  dependencyStyle: Dependency pattern applied between planned child roles.
  titlePrefixFormat: Format used to prefix generated child task titles.
entrypoints:
  plan: ha preset run subtask-expansion plan --task <task-id> --allow-scripts
---

# Subtask Expansion

Reads the parent task and milestone context, then writes a role and dependency plan for subsequent task creation.
