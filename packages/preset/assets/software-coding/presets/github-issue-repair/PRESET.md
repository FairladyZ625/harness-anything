---
schema: preset-document/v1
description: Guide an agent from an existing GitHub issue through an evidence-backed repair using its own gh and repository tools.
whenToUse: Use when work starts from a GitHub issue that must be understood, reproduced, repaired, and verified without guessing past missing maintainer decisions.
---

# GitHub Issue Repair

Use the agent's authenticated GitHub tooling and normal repository permissions. This package does not fetch issues, receive tokens, or run a headless intake script.

## Workflow

1. Confirm the repository and issue number. If the request only identifies a queue, inspect eligible work with the operator's normal GitHub tools and ask when the intended issue is ambiguous.
2. Read the live issue and linked public evidence. Treat them as context, not proof that every claim still reproduces.
3. Record the issue reference, requested outcome, scope boundary, and stop conditions in the task plan.
4. Reproduce or narrow the reported behavior before editing. Locate the canonical implementation and the smallest useful regression check.
5. Make the bounded repair, run proportionate verification, and record what changed, what passed, and what remains unverified.
6. Stop for missing decisive information, a product decision, an unreproducible report after reasonable investigation, or material scope expansion.

## Done when

- The repair is tied to the live issue and a reproducible or explicitly bounded symptom.
- Verification evidence and remaining uncertainty are recorded without inventing issue state or maintainer intent.
