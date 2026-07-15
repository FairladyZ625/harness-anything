---
schema: preset-document/v1
description: Inventory legacy harness material and prepare a migration plan without mutating the source content.
whenToUse: Use when older task, decision, or documentation layouts must be brought into the current harness model.
---

# Legacy Migration

Inventory and migrate legacy material with the agent's normal repository tools.
Treat the legacy source as evidence: read it in place, preserve provenance, and do
not promise unattended conversion.

## Workflow

1. Read the repository instructions and identify the exact legacy source roots
   approved for this migration. Do not broaden the source set by guessing.
2. Inventory relevant tasks and documents with paths, titles, status signals,
   checksums when useful, and evidence pointers. Record ambiguous mappings for
   human review.
3. Classify each item as preserve, rebuild, supersede, archive, or ignore. Explain
   the treatment and the destination before copying or rewriting anything.
4. Preserve approved historical evidence under the repository's legacy area.
   Forward only safe, still-authoritative context into active locations.
5. Rebuild active work through normal `ha task create`, decision, relation, and
   governed document commands. Do not turn an old directory into a current task
   by renaming or copying it wholesale.
6. Verify source provenance, destination links, collisions, and omitted material.
   Record commands, counts, unresolved mappings, and follow-up tasks.

## Done when

- Every in-scope legacy item has a documented treatment and destination.
- The original source remains intact and preserved evidence retains provenance.
- Current tasks and documents were created through their normal governed paths,
  with ambiguous mappings left explicit for human review.
