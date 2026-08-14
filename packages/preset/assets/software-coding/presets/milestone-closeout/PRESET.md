---
schema: preset-document/v1
description: Verify milestone criteria, constituent tasks, decisions, and evidence before declaring the milestone closed.
whenToUse: Use at milestone wrap-up when completion claims must be checked against the milestone boundary.
---

# Milestone Closeout

Review the milestone's real task, decision, repository, and delivery evidence. This package supplies discovery and inspect guidance only; it does not claim a machine verdict or fabricate a closeout executor.

## Workflow

1. Resolve the milestone root task, charter decision, constituent tasks, dependencies, and declared exit criteria from canonical views.
2. Review each criterion against concrete evidence such as merged source, tests, CI receipts, released artifacts, task facts, and accepted decisions.
3. Treat unchecked criteria, placeholders, missing evidence, unresolved required tasks, and unaccepted load-bearing decisions as red. Give intentional deferrals an owner and follow-up task.
4. Reconcile milestone state across its overview, root task, constituent tasks, dependency graph, and open risks.
5. Record a factual closeout summary with shipped scope, exclusions, verification evidence, deferrals, and residual risks through governed task-document routes.
6. Complete the root task only through its normal lifecycle after required review and completion gates are satisfied.

## Done when

- Every exit criterion is supported by concrete evidence or explicitly deferred.
- Task, decision, dependency, and milestone views agree without relying on a generated self-report.
