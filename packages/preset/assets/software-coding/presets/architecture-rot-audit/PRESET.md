---
schema: preset-document/v1
description: Detect structural architecture drift and record actionable findings for a software product.
whenToUse: Use before a release or architecture-focused refactor, or when ownership and boundary erosion need evidence.
---

# Product Architecture Rot Audit

Use the repository's own source, architecture map, decisions, and checks to find
structural drift. The agent performs the audit with its normal repository tools;
this preset does not declare or run a bundled entrypoint.

## Workflow

1. Read the repository instructions and authoritative architecture material.
2. Establish the comparison boundary for the audit.
3. Inspect ownership, dependency direction, public seams, duplicated policy,
   manual mirrors, and enforcement gaps.
4. Reproduce every finding with a command or source reference.
5. Separate verified defects from hypotheses and assign a disposition.
6. Run the repository checks appropriate to the touched surface.

## Done when

- Every finding has reproducible evidence and an owner or explicit disposition.
- Architecture intent and implementation evidence agree, or the mismatch is
  recorded as work.
- The task contains commands, results, and residual risks.
