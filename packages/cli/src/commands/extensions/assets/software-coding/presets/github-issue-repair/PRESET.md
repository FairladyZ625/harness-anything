---
schema: preset-document/v1
description: Guide an agent from an existing GitHub issue through an evidence-backed repair using its own gh and repository tools.
whenToUse: Use when work starts from a GitHub issue that must be understood, reproduced, repaired, and verified without guessing past missing maintainer decisions.
---

# GitHub Issue Repair

Use the agent's own authenticated GitHub tooling and normal repository permissions. This
preset does not fetch issues, receive tokens, or run a headless intake script.

1. Confirm the repository and issue number. If the request only describes a queue,
   inspect eligible work with `gh issue list --repo <owner/name>` and ask the user when
   the intended issue is ambiguous.
2. Read the current issue with
   `gh issue view <number> --repo <owner/name> --json number,title,body,state,labels,url`.
   Treat the live issue and linked public evidence as context, not as proof that every
   claim still reproduces.
3. Record the issue reference, requested outcome, scope boundary, and stop conditions
   in the task plan. Keep evidence freeform and cite the commands, files, and outputs
   actually inspected.
4. Reproduce or narrow the reported behavior before editing. Follow the repository's
   architecture and testing guidance to locate the canonical implementation and the
   smallest useful regression check.
5. Make the scoped repair, run proportionate verification, and update task evidence
   with what changed, what passed, and what remains unverified.
6. Stop and ask the user or maintainer when the issue is missing decisive information,
   cannot be reproduced after reasonable investigation, requires a product decision,
   or would materially broaden scope.
