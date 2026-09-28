---
schema: preset-document/v1
description: Turn a parent task into a concrete worker plan with explicit roles and dependency ordering.
whenToUse: Use when a bounded parent task is ready to be decomposed into independently executable child responsibilities.
---

# Subtask Expansion

Decompose a parent task into independently executable outcomes with bounded scope, acceptance evidence, and justified dependency ordering. Create each child with `ha task create --preset subtask-expansion --work <task-id>`, which files it under that task and so inside the same work; task create rejects a missing parent before publication and preserves the accepted parent binding in the task package and projection.
