export { createTaskIdentity } from "./task.ts";
export type { Task, TaskIdentity, TaskId, EngineId, ExternalRef, IsoTimestamp, Sha256Fingerprint } from "./task.ts";

export {
  domainStatuses,
  openDomainStatuses,
  terminalDomainStatuses,
  reviewArtifactStatuses,
  explainStatusTransition,
  isDomainStatus,
  isTerminalStatus,
  needsReviewArtifacts,
  statusCoarseClass
} from "./lifecycle-status.ts";
export type { DomainStatus, CanonicalStatus, StatusCoarseClass, StatusTransitionExplanation, StatusTransitionRejectionReason } from "./lifecycle-status.ts";

export {
  decisionStates,
  explainDecisionStateTransition,
  isDecisionState
} from "./decision-lifecycle-status.ts";
export type { DecisionState, DecisionStateTransitionExplanation, DecisionStateTransitionRejectionReason } from "./decision-lifecycle-status.ts";

export { immutableBindingFields, validateLifecycleBindingInvariant } from "./lifecycle-binding.ts";
export type { LifecycleBinding, BindingInvariantResult, ImmutableBindingField } from "./lifecycle-binding.ts";

export { closeoutReadinesses, isCloseoutReadiness } from "./closeout-readiness.ts";
export type { CloseoutReadiness } from "./closeout-readiness.ts";

export { packageDispositions, isPackageDisposition } from "./package-disposition.ts";
export type { PackageDisposition } from "./package-disposition.ts";

export { findEntityRefs, parseEntityRef } from "./entity-ref.ts";
export type { EntityRefKind, ParsedEntityRef } from "./entity-ref.ts";

export { decisionEntityId, decisionIdFromEntityId, parseWriteEntityId, taskEntityId, taskIdFromEntityId } from "./entity-id.ts";
export type { EntityId, ParsedWriteEntityId } from "./entity-id.ts";

export {
  factConfidenceLevels,
  factMemoryClasses,
  factMemoryTags,
  formatFactFlowRecord,
  isFactMemoryClass,
  isFactMemoryTag,
  isFactId,
  parseFactFlowRecords
} from "./fact-record.ts";
export type { FactConfidence, FactMemoryClass, FactMemoryTag, FactRecord } from "./fact-record.ts";

export {
  isRuntimeEventApprovalDecision,
  isRuntimeEventInterruptAction,
  isRuntimeEventKind,
  isRuntimeEventResultStatus,
  runtimeEventApprovalDecisions,
  runtimeEventInterruptActions,
  runtimeEventKinds,
  runtimeEventResultStatuses
} from "./runtime-event.ts";
export type {
  RuntimeEventApprovalDecision,
  RuntimeEventInterruptAction,
  RuntimeEventKind,
  RuntimeEventRecord,
  RuntimeEventRuntime,
  RuntimeEventResultStatus
} from "./runtime-event.ts";

export { docmapDocumentKinds } from "./docmap.ts";
export type { DocmapDocument, DocmapDocumentKind, DocmapManifest, DocmapReadSet, DocmapScope } from "./docmap.ts";

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
  TemplateLibraryError,
  WriteError
} from "./errors.ts";

export {
  validateExtensionInputShape,
  validateTemplateCatalog,
  validatePresetManifests,
  validateVerticalDefinition,
  planTemplateMaterialization,
  formatTemplateRef
} from "./extension-model.ts";
export type {
  ExtensionValidationIssue,
  ExtensionValidationResult,
  KernelVersionContext,
  MaterializationRequest,
  MaterializedTemplatePlan,
  MaterializationResult,
  ExtensionInputKind
} from "./extension-model.ts";
