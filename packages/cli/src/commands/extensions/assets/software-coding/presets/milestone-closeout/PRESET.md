---
schema: preset-document/v1
description: Verify milestone criteria, constituent tasks, decisions, and evidence before declaring the milestone closed.
whenToUse: Use at milestone wrap-up when completion claims must be checked against the milestone boundary.
---

# Milestone Closeout

Close the milestone by reviewing its real task, decision, repository, and delivery
evidence. The agent performs the review with normal `ha`, Git, and project tools;
this preset does not produce a machine verdict.

## Workflow

1. Resolve the milestone root task, charter decision, map, constituent tasks,
   dependencies, and declared exit criteria.
2. Review each criterion against concrete evidence such as merged source,
   tests, CI receipts, released artifacts, task facts, and accepted decisions.
   Keep evidence freeform but specific and independently checkable.
3. Treat unchecked criteria, placeholders, missing evidence, unresolved required
   tasks, and unaccepted load-bearing decisions as red. Record intentional
   deferrals with an owner and follow-up task.
4. Reconcile milestone status across the overview, index, summary views, root
   task, and constituent tasks. Confirm that open risks match the closeout claim.
5. Write a factual closeout summary, verification commands and results, shipped
   scope, exclusions, and residual risks through the repository's governed task
   document route. Record supporting facts and progress with `ha`.
6. Run the relevant local and repository checks. Complete the root task only
   after required review and completion gates are satisfied.

## Done when

- Every exit criterion is supported by concrete evidence or explicitly deferred.
- Task, decision, dependency, and milestone status agree across canonical views.
- Closeout records verification results, shipped scope, and residual risk without
  relying on a generated self-report.
