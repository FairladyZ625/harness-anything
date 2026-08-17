export { createTaskIdentity } from "./task.ts";
export type { ActorAxes, Task, TaskIdentity, TaskId, EngineId, ExternalRef, IsoTimestamp, Sha256Fingerprint } from "./task.ts";
export { REPLAY_TASK_GRAPH } from "./task-graph.ts";
export { TASK_LIFECYCLE_COMMAND_CATALOG } from "./task-lifecycle.contract.ts";
export type {
  CompleteTaskCommand,
  CreateReplayTaskCommand,
  RecordReviewCommand,
  StartExecutionCommand,
  SubmitExecutionCommand
} from "./task-lifecycle.contract.ts";
export type { TaskLifecycleCommandType } from "./task-write-decision.ts";

export { reviewVerdicts } from "./review.ts";
export type { ReviewVerdict } from "./review.ts";

export { isPriorityTier, isTaskWorkKind, priorityTiers, taskWorkKinds } from "./task-metadata.ts";
export type { PriorityTier, TaskWorkKind } from "./task-metadata.ts";

export { explainStatusTransition, isDomainStatus, isTerminalStatus } from "./lifecycle-status.ts"; export type { CanonicalStatus, DomainStatus, StatusCoarseClass, StatusTransitionExplanation, StatusTransitionRejectionReason } from "./lifecycle-status.ts";

export { immutableBindingFields, validateLifecycleBindingInvariant } from "./lifecycle-binding.ts";
export type { LifecycleBinding, BindingInvariantResult, ImmutableBindingField } from "./lifecycle-binding.ts";

export { closeoutReadinesses, isCloseoutReadiness } from "./closeout-readiness.ts";
export type { CloseoutReadiness } from "./closeout-readiness.ts";

export { DEFAULT_TASK_WIP_LIMIT, admitTaskExecutionWip, hasCloseoutEvidence, parseTaskWipLimit, taskWipOccupyingStatuses } from "./task-wip-policy.ts";
export type { TaskWipSnapshotEntryV1 } from "./task-wip-policy.ts";

export { findEntityRefs, parseEntityRef } from "./entity-ref.ts";
export type { EntityRefKind, ParsedEntityRef } from "./entity-ref.ts";

export { decisionEntityId, decisionIdFromEntityId, moduleEntityId, moduleKeyFromEntityId, parseWriteEntityId, taskEntityId, taskIdFromEntityId } from "./entity-id.ts";
export type { EntityId, ParsedWriteEntityId } from "./entity-id.ts";

export { compileDecisionWrite, compileFactWrite, decisionDocumentProse, decisionMachineDigest, decisionStates, decisionWritePlan, factConfidenceLevels, factMemoryClasses, factMemoryTags, factWritePlan, isFactId } from "./fact-event.ts";
export type { DecisionAmendableSnapshot, DecisionEventDraftV1, DecisionEventV1, DecisionState, FactConfidence, FactEventDraftV1, FactEventV1, FactMemoryClass, FactMemoryTag } from "./fact-event.ts";

export { createEntityKindRegistry, getEntityKind } from "./entity-kind-registry.ts";
export type {
  EntityKindDeclaration,
  EntityKindRegistration,
  EntityKindRegistry,
  EntityPackageScaffold,
  EntityRepositoryRootScaffold
} from "./entity-kind-registry.ts";

export {
  canonicalRelationIdentityInput,
  deriveRelationId,
  formatRelationFlowRecord,
  isAllowedRelationKindTriple,
  relationDirections,
  relationOrigins,
  relationStates,
  relationStrengths,
  relationTypes,
  validateRelationRecordsForHost
} from "./entity-relation.ts";
export type {
  EntityRelationRecord,
  EntityRelationValidationIssue,
  EntityRelationValidationIssueCode,
  RelationDirection,
  RelationOrigin,
  RelationState,
  RelationStrength,
  RelationType
} from "./entity-relation.ts";

export type {
  EngineError,
  BindingInvariantError,
  ArtifactStoreError,
  TemplateLibraryError
} from "./errors.ts";

export {
  validateExtensionInputShape,
  validateTemplateCatalog,
  validateVerticalDefinition,
  planTemplateMaterialization,
  formatTemplateRef
} from "./extension-model.ts";
export type {
  ExtensionValidationIssue,
  ExtensionValidationResult,
  MaterializationRequest,
  MaterializedTemplatePlan,
  MaterializationResult,
  ExtensionInputKind,
  TemplateBodyResolver
} from "./extension-model.ts";
