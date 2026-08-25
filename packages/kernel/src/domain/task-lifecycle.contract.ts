// Public compatibility façade for the task lifecycle contract.
export {
  TaskLifecycleContractError,
  TASK_EVENT_V1_SCHEMA,
  serializeTaskEvent,
  taskEventTypes,
  validateCurrentTaskEvent,
  validateTaskEvent,
} from "./task-lifecycle-event.ts";
export type {
  CodeDocReconciledEvent,
  CodeDocRepointedEvent,
  CompletionGateVerifiedEvent,
  ExecutionExecutorDeclaredEvent,
  ExecutionStartedEvent,
  ExecutionSubmittedEvent,
  LeaseChangeReason,
  LeaseRenewedEvent,
  LifecycleDocumentClaim,
  ReviewConsentRecordedEvent,
  ReviewRecordedEvent,
  TaskCompletedEvent,
  TaskCreatedEvent,
  TaskEventType,
  TaskEventV1,
  TaskLifecycleErrorCode,
} from "./task-lifecycle-event.ts";
export {
  canonicalCodeDocPaths,
  codeDocRecordId,
  currentCodeDocRecord,
  currentCodeDocWitness,
  sameCodeDocPaths,
  validateCodeDocRepointV1,
  validateCodeDocWitnessV1,
} from "./code-doc-witness.ts";
export type { CodeDocRepointV1, CodeDocWitnessRecord, CodeDocWitnessV1 } from "./code-doc-witness.ts";
export { reviewDigest } from "./review.ts";
export {
  TASK_LIFECYCLE_SCHEMA,
  type CodeDocProof,
  type CompleteTaskProof,
  type CompleteTaskCommand,
  type CreateReplayTaskCommand,
  type CreateReplayTaskIntent,
  type CreateReplayTaskProof,
  type NormalizedTaskLifecycleCommand,
  type ProofFor,
  type ReconcileCodeDocCommand,
  type ReconcileCodeDocIntent,
  type RepointCodeDocCommand,
  type RepointCodeDocIntent,
  type RepointCodeDocProof,
  type RecordReviewCommand,
  type RecordReviewConsentCommand,
  type RecordReviewConsentIntent,
  type RecordReviewIntent,
  type ReviewConsentProof,
  type ReviewProof,
  type StartExecutionCommand,
  type StartExecutionIntent,
  type StartExecutionProof,
  type SubmitExecutionCommand,
  type SubmitExecutionIntent,
  type SubmitExecutionProof,
  type TaskLifecycleCommand,
  type TaskLifecycleCommandIntent,
  type TaskLifecycleSnapshot,
  type TransitionResult,
  type TransitionTaskCommand,
  type TransitionTaskIntent,
  type TransitionTaskProof,
} from "./task-lifecycle-contract-internal-types.ts";
export {
  normalizeTaskLifecycleCommand,
  validateTaskLifecycleCommandEnvelope,
} from "./task-lifecycle-contract-commands.ts";
export {
  canonicalGateReceipts,
  emptyTaskLifecycleSnapshot,
  executionExecutorDeclarationCandidates,
  heldLeaseForExecutionActor,
} from "./task-lifecycle-contract-support.ts";
export { allowsTaskStatusMove, canStartExecution } from "./task-lifecycle-command-transitions.ts";
export { isReadyToComplete } from "./task-lifecycle-review-transitions.ts";
export { findTaskLifecycleTransition, TASK_LIFECYCLE_TRANSITIONS } from "./task-lifecycle-transitions.ts";
export {
  applyTransition,
  compileExecutionExecutorDeclaration,
  reduceTaskEvent,
  validateTransition,
} from "./task-lifecycle-replay.ts";
export {
  TASK_LIFECYCLE_COMMAND_CATALOG,
  TASK_LIFECYCLE_PROJECTION_FIELDS,
  type TaskLifecycleCliCatalogEntry,
} from "./task-lifecycle-contract-catalog.ts";
export { default } from "./task-lifecycle-contract-catalog.ts";
