---
schema: preset-document/v1
description: Detect structural architecture drift and record actionable findings for a software product.
whenToUse: Use before a release or architecture-focused refactor, or when ownership and boundary erosion need evidence.
---

# Product Architecture Rot Audit

Use the repository's own source, architecture map, decisions, and checks to find
structural drift. The agent performs the audit with its normal repository tools;
this preset does not run a bundled detector.

## Workflow

1. Read the repository instructions and authoritative architecture material
   before inspecting implementation details.
2. Establish the comparison boundary: the current change, the relevant release,
   or a named architecture refactor. Use Git history and existing task evidence
   only as supporting context.
3. Inspect package ownership, dependency direction, public seams, duplicated
   policy, manual mirrors, and enforcement gaps with tools such as `rg`, Git,
   package manifests, and the repository's graph or type checks.
4. Reproduce every finding with a concrete command or source reference. Record
   the affected paths, the intended boundary, observed behavior, severity, and
   the smallest credible remediation.
5. Separate verified defects from hypotheses. Open follow-up tasks for accepted
   remediation and record non-blocking observations in the current task.
6. Run the repository checks appropriate to the touched surface. Never weaken a
   gate or rewrite its authority data to make an audit appear green.

## Done when

- Every finding has reproducible evidence and an owner or explicit disposition.
- Architecture documentation and implementation evidence agree, or the mismatch
  is recorded as work rather than silently normalized.
- The task contains the commands run, results, and residual risks.
