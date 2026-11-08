/**
 * Authorized by dec_399F48E3547D831F1199F51E84 CH1.
 * Counts are ceilings: deleting a construction site tightens the ratchet,
 * while adding one requires an explicit governance change.
 */
export const TASK_EVENT_CONSTRUCTION_ALLOWLIST = Object.freeze({
  // dec_5EC2631352B17EE2BF4979E37E; owner-authorized single offline Task retirement constructor.
  "packages/kernel/src/domain/task-completion-generation-retirement.ts|envelope-call|task_completion_generation_retired": 1,
  "packages/daemon/src/repo-cell-task-command-docs.ts|dynamic-task-event|<dynamic>": 1,
  // Existing metadata-amend constructor moved to a pure aggregate builder shared with ReworkTask.
  "packages/kernel/src/domain/task-lifecycle-event.ts|literal-type|task_amended": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_archived": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_contract_migrated": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_deleted": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_relation_added": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_reopened": 1,
  "packages/daemon/src/repo-cell-task-mutation.ts|literal-type|task_superseded": 1,
  "packages/kernel/src/domain/task-lifecycle-command-transitions.ts|envelope-call|task_created": 1,
  "packages/kernel/src/domain/task-lifecycle-command-transitions.ts|envelope-call|task_transitioned": 1,
  "packages/kernel/src/domain/task-lifecycle-contract-support.ts|dynamic-task-event|<dynamic>": 1,
  "packages/kernel/src/domain/task-lifecycle-review-transitions.ts|envelope-call|task_completed": 1,
  "packages/kernel/src/domain/task-lifecycle-review-transitions.ts|envelope-call|task_review_responded": 1,
  "packages/kernel/src/domain/task-progress-event.ts|literal-type|task_progress_appended": 1,
  "packages/preset/src/preset-bootstrap.ts|literal-type|task_bootstrapped": 1,
});

/**
 * Authorized by dec_6B912A63D279A922FA1288536D CH1 (AuthoredDocument aggregate, slice 2).
 * The aggregate's private envelope builder is the only constructor; each event type has exactly
 * one decision site. Same ceiling semantics as the task_* allowlist.
 */
export const AUTHORED_DOCUMENT_EVENT_CONSTRUCTION_ALLOWLIST = Object.freeze({
  "packages/kernel/src/domain/authored-document.ts|dynamic-task-event|<dynamic>": 1,
  "packages/kernel/src/domain/authored-document.ts|envelope-call|authored_document_registered": 1,
  "packages/kernel/src/domain/authored-document.ts|envelope-call|authored_document_revised": 1,
  "packages/kernel/src/domain/authored-document.ts|envelope-call|authored_document_retired": 1,
});
