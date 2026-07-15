---
schema: preset-document/v1
description: Turn a parent task into a concrete worker plan with explicit roles and dependency ordering.
whenToUse: Use when a bounded parent task is ready to be decomposed into independently executable child responsibilities.
---

# Subtask Expansion

Decompose the parent task with the agent's normal task and relation commands. Use
the parent plan and current relation graph as the source of intent; do not create
children from a fixed role template when the work does not need them.

## Workflow

1. Read the parent task plan, acceptance criteria, current status, milestone
   boundary, existing children, and dependency relations.
2. Split work into independently executable outcomes. Give each child one clear
   objective, bounded scope, acceptance criteria, verification evidence, and
   stop conditions.
3. Check for an existing child with the same responsibility before creating a
   new one. Create needed children with `ha task create --parent <task-id>` and
   the appropriate preset.
4. Add only real ordering constraints with `ha task relate ... depends-on ...`
   and a concrete rationale. Keep independent work parallel and avoid cycles.
5. Put the context required for execution into each child task rather than
   relying on conversation history. Record cross-cutting risks and decisions on
   the parent.
6. Review the resulting task and relation graph, then append the child ids,
   dependency rationale, and remaining unsplit work to parent progress.

## Done when

- Every child is independently understandable and has a verifiable outcome.
- Existing children were reused, dependency edges are acyclic and justified,
  and no speculative role-only tasks were created.
- The parent records the final child map and any work intentionally kept local.
