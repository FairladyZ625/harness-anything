---
schema: preset-document/v1
description: Inventory legacy harness material and prepare a migration plan without mutating the source content.
whenToUse: Use when older task, decision, or documentation layouts must be brought into the current harness model.
entrypoints:
  plan: ha preset run legacy-migration plan --task <task-id> --allow-scripts
---

# Legacy Migration

Reads known legacy documentation and harness locations, then writes a migration plan into the selected task package.
