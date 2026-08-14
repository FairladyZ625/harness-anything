---
schema: preset-document/v1
description: Inventory legacy harness material and prepare a migration plan without mutating the source content.
whenToUse: Use when older task, decision, or documentation layouts must be brought into the current harness model.
---

# Legacy Migration

Treat legacy material as read-only evidence. This package supplies an inventory and migration workflow; it does not perform unattended conversion or reopen legacy write paths.

## Workflow

1. Read repository instructions and identify the exact legacy source roots approved for migration. Do not broaden the source set by guessing.
2. Inventory relevant tasks and documents with paths, status signals, checksums when useful, and evidence pointers. Record ambiguous mappings for human review.
3. Classify each item as preserve, rebuild, supersede, archive, or ignore, and explain its treatment and destination before copying or rewriting anything.
4. Preserve approved historical evidence under the repository's current legacy area. Forward only safe, still-authoritative context into active locations.
5. Rebuild active work through current governed task, decision, relation, and document commands. Do not make an old directory current by renaming or copying it wholesale.
6. Verify provenance, destination links, collisions, omissions, and unresolved mappings.

## Done when

- Every in-scope item has a documented treatment and destination.
- The source remains intact, governed destinations were used, and ambiguous mappings remain explicit.
