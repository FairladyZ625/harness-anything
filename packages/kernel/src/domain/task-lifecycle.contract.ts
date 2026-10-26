// Public compatibility façade for the task lifecycle contract.
export {
  TaskLifecycleContractError,
  TASK_EVENT_SHAPE_COMPAT_VERSION,
  TASK_EVENT_V1_SCHEMA,
  serializeTaskEvent,
  taskEventTypes,
  validateCurrentTaskEvent,
  validateTaskEvent,
} from "./task-lifecycle-event.ts";
export type {
  CompletionGateVerifiedEvent,
  ExecutionAnnotatedEvent,
  ExecutionExecutorDeclaredEvent,
  ExecutionStartedEvent,
  ExecutionSubmittedEvent,
  LeaseChangeReason,
  LeaseRenewedEvent,
  LifecycleDocumentClaim,
  ReviewConsentRecordedEvent,
  ReviewRecordedEvent,
  TaskReviewRespondedEvent,
  TaskCompletedEvent,
  TaskCreatedEvent,
  TaskEventType,
  TaskEventV1,
  TaskLifecycleErrorCode,
} from "./task-lifecycle-event.ts";
export { reviewDigest } from "./review.ts";
export {
  TASK_LIFECYCLE_SCHEMA,
  type CompleteTaskProof,
  type CompleteTaskCommand,
  type CreateReplayTaskCommand,
  type CreateReplayTaskIntent,
  type CreateReplayTaskProof,
  type ForwardedCutRecord,
  type NormalizedTaskLifecycleCommand,
  type ProofFor,
  type RecordReviewCommand,
  type RecordReviewConsentCommand,
  type RecordReviewConsentIntent,
  type RecordReviewIntent,
  type RespondReviewCommand,
  type RespondReviewIntent,
  type ReviewConsentProof,
  type ReviewProof,
  type ReviewResponseProof,
  type StartExecutionCommand,
  type StartExecutionIntent,
  type StartExecutionProof,
  type SubmitExecutionCommand,
  type SubmitExecutionIntent,
  type SubmitExecutionProof,
  type ReworkTaskCommand,
  type ReworkTaskIntent,
  type ReworkTaskProof,
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
  requiredGateWitnessCount,
} from "./task-lifecycle-contract-support.ts";
export { allowsTaskStatusMove, canStartExecution } from "./task-lifecycle-command-transitions.ts";
export { isReadyToComplete } from "./task-lifecycle-review-transitions.ts";
export { TASK_LIFECYCLE_TRANSITIONS } from "./task-lifecycle-transitions.ts";
export {
  applyTransition,
  compileExecutionAnnotation,
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
