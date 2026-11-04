# Task Lifecycle RPC Capability Contract

This is the public capability contract for clients such as Studio that use the
Harness daemon instead of importing the CLI or kernel. The transport method is
`repo.task.run`; its payload is the declared Task Action object. The daemon
authorizes the action through the same policy scope as the CLI and then applies
the canonical lifecycle transition.

| Studio intent                  | RPC action                                                                                  | Required fields                                                                          | Authorization scope | Minimum policy tier |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- | ------------------- |
| Unblock a task                 | `{ "kind": "task-transition", "taskId": "<id>", "status": "active" }`                       | `taskId`, `status`; `reason` is optional                                                 | `task/transition`   | `contributor`       |
| Cancel a task                  | `{ "kind": "task-transition", "taskId": "<id>", "status": "cancelled", "reason": "<why>" }` | `taskId`, `status`, `reason`; add `force: true` after execution has started              | `task/transition`   | `contributor`       |
| Replan a task                  | `{ "kind": "task-transition", "taskId": "<id>", "status": "planned", "reason": "<why>" }`   | `taskId`, `status`, `reason`                                                             | `task/transition`   | `contributor`       |
| Return a review cut or a review-exempt submitted cut for rework | `{ "kind": "task-rework", "taskId": "<id>", "reason": "<why>" }`                            | `taskId`, `reason`; `executionId` and `reviewId` may identify the current cut explicitly | `task/rework`       | `maintainer`        |

For example, an unblock request uses this envelope:

```json
{
  "repo": { "repoId": "registered-repository-id" },
  "payload": {
    "action": { "kind": "task-transition", "taskId": "task-id", "status": "active" }
  }
}
```

`task-transition` accepts the generic target vocabulary `planned`, `active`,
`blocked`, `in_review`, `done`, and `cancelled`. The `submitted` status is
owned by `task-submit` and is intentionally absent from generic transition
input. The lifecycle status table remains the authority for whether a target
is legal from the task's current status. The aggregate also preserves the lease,
graph cursor, execution and review guards: every generic move requires an
unleased task. Unblock requires `blocked`; replan requires `active` or `blocked`
at the implementation node. Replan advances the iteration if an active execution
occupies that round. A cancelled task can be reinstated only to `planned` with a
reason. `force` permits cancellation after execution has started; it does not
bypass a lease or authorization.

An accepted wire value can still be rejected as `invalid_transition`; in
particular, the generic action cannot enter or complete review, or return a
submitted cut to implementation. Use the execution-bound actions instead.
Missing audit reasons remain `missing_field` failures from the aggregate;
post-start cancellation without `force` remains `force_reason_required`.

`task-rework` is the existing owner return action. It requires an unleased task
at the review gate — `in_review` for a review-gated cut, or review-exempt
`submitted` for a cut whose frozen contract lifted the review gate — with a
current submitted execution, the task-owning principal,
the server-issued `task-rework@v1` proof, and an auditable reason. It returns the
task to `active` at the implementation node, advances its iteration and closes
the submitted execution as `changes_requested`. The owner still needs the
current `task/rework` grant; another maintainer is rejected as `invalid_proof`.
A recorded changes-requested review within the configured automatic budget
returns the cut through the existing review reducer. Studio should call
`task-rework` when it needs an explicit owner return. `task-reopen` restores an
archived or tombstoned package and is not a review-return action.

Policy denial returns `authorization_denied` and publishes no lifecycle event.
All writes use the existing center RepoCell queue and writer epoch; concurrent
clients do not acquire a separate lifecycle implementation. The work here adds
no new action, permission, storage path, or per-task collection scan.

The canonical declarations are
[`task-action-contract.ts`](../packages/kernel/src/domain/task-action-contract.ts),
[`lifecycle-status.ts`](../packages/kernel/src/domain/lifecycle-status.ts), and
[`action-declaration.ts`](../packages/kernel/src/domain/action-declaration.ts).
This document is a client-facing index, not a second schema.
