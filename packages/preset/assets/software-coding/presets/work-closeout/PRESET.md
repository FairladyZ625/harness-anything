---
schema: preset-document/v1
description: Verify a work's criteria, constituent tasks, decisions, and evidence before declaring the work closed.
whenToUse: Use at work wrap-up when completion claims must be checked against the work boundary.
---

# Work Closeout

Review the work's real task, decision, repository, and delivery evidence. This package supplies discovery and inspect guidance only; it does not claim a machine verdict or fabricate a closeout executor.

## Workflow

1. Resolve the work root task, charter decision, constituent tasks (`ha work show <root-task-id>`), dependencies, and declared exit criteria from canonical views.
2. Review each criterion against concrete evidence such as merged source, tests, CI receipts, released artifacts, task facts, and accepted decisions.
3. Treat unchecked criteria, placeholders, missing evidence, unresolved required tasks, and unaccepted load-bearing decisions as red. Give intentional deferrals an owner and follow-up task.
4. Reconcile work state across its plan, root task, constituent tasks, dependency graph, and open risks.
5. Record a factual closeout summary with shipped scope, exclusions, verification evidence, deferrals, and residual risks through governed task-document routes.
6. Complete the root task only through its normal lifecycle after required review and completion gates are satisfied.

## Done when

- Every exit criterion is supported by concrete evidence or explicitly deferred.
- Task, decision, dependency, and work views agree without relying on a generated self-report.
