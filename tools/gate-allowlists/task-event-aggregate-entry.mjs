/**
 * Authorized by dec_399F48E3547D831F1199F51E84 CH1.
 * Counts are ceilings: deleting a construction site tightens the ratchet,
 * while adding one requires an explicit governance change.
 */
export const TASK_EVENT_CONSTRUCTION_ALLOWLIST = Object.freeze({
  "packages/daemon/src/repo-cell-task-command-docs.ts|dynamic-task-event|<dynamic>": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_amended": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_archived": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_contract_migrated": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_deleted": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_relation_added": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_reopened": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_superseded": 1,
  "packages/kernel/src/domain/task-lifecycle.contract.ts|dynamic-task-event|<dynamic>": 1,
  "packages/kernel/src/domain/task-lifecycle.contract.ts|envelope-call|task_completed": 1,
  "packages/kernel/src/domain/task-lifecycle.contract.ts|envelope-call|task_created": 1,
  "packages/kernel/src/domain/task-lifecycle.contract.ts|envelope-call|task_transitioned": 1,
  "packages/kernel/src/domain/task-progress-event.ts|literal-type|task_progress_appended": 1,
  "packages/preset/src/preset-bootstrap.ts|literal-type|task_bootstrapped": 1
});
