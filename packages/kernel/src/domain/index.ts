export { createTaskIdentity } from "./task.ts";
export { currentActionEnvelopeVersion, validateActionEnvelope } from "./action-envelope.ts";
export type { ActionEnvelope } from "./action-envelope.ts";
export type { ReceiptJsonValue } from "./receipt-frame.ts";
export type { AuthorizationDecision } from "./receipt-frame.ts";
export {
  ENTITY_ACTION_EXPLANATION_SCHEMA,
  validateEntityActionExplainRequest,
  validateEntityActionExplanationSet,
} from "./entity-action-explanation.ts";
export type {
  EntityActionCriterionExplanationV1,
  EntityActionExplainRequestV1,
  EntityActionExplanationFailureCode,
  EntityActionExplanationSetV1,
  EntityActionExplanationSubjectV1,
  EntityActionExplanationV1,
} from "./entity-action-explanation.ts";
export type { EntityActionUnmetCriterionV1 } from "./receipt-domain-registry.ts";
export type { DecisionCapabilityId, DecisionCapabilityReason } from "./decision-board-projection.ts";
export { deriveActionReturnsContract } from "./entity-action-descriptor.ts";
export type { ReceiptGuidanceArgument, ReceiptGuidanceContractEntry } from "./entity-action-descriptor.ts";
export { evaluateTaskActionCapability, taskActionUsage } from "./task-action-capability.ts";
export { DEFAULT_POLICY, durablePolicyActions } from "./default-policy.ts";
export type {
  ActorAxes,
  Task,
  TaskIdentity,
  TaskId,
  EngineId,
  ExternalRef,
  IsoTimestamp,
  Sha256Fingerprint,
} from "./task.ts";
export { REPLAY_TASK_GRAPH } from "./task-graph.ts";
export { TASK_LIFECYCLE_COMMAND_CATALOG, TASK_LIFECYCLE_TRANSITIONS } from "./task-lifecycle.contract.ts";
export type {
  CompleteTaskCommand,
  CreateReplayTaskCommand,
  RecordReviewCommand,
  StartExecutionCommand,
  SubmitExecutionCommand,
} from "./task-lifecycle.contract.ts";
export type { TaskLifecycleCommandType } from "./task-write-decision.ts";

export {
  approvedReviewHistoryForExecution,
  approvedReviewsForExecution,
  consentedApprovedReviewForExecution,
  reviewVerdicts,
} from "./review.ts";
export type { ReviewVerdict } from "./review.ts";

export { isPriorityTier, isTaskWorkKind, priorityTiers, taskWorkKinds } from "./task-metadata.ts";
export type { PriorityTier, TaskWorkKind } from "./task-metadata.ts";

export { explainStatusTransition, isDomainStatus, isTerminalStatus } from "./lifecycle-status.ts";
export type {
  CanonicalStatus,
  DomainStatus,
  StatusCoarseClass,
  StatusTransitionExplanation,
  StatusTransitionRejectionReason,
} from "./lifecycle-status.ts";

export { immutableBindingFields, validateLifecycleBindingInvariant } from "./lifecycle-binding.ts";
export type { LifecycleBinding, BindingInvariantResult, ImmutableBindingField } from "./lifecycle-binding.ts";

export {
  closeoutReadiness,
  closeoutReadinesses,
  currentExecutionCuts,
  currentSubmittedExecutions,
  isCloseoutReadiness,
} from "./closeout-readiness.ts";
export type { CloseoutReadiness, CloseoutSnapshot } from "./closeout-readiness.ts";
export { blockingOf } from "./task-blocking.ts";
export type { BlockingLabel } from "./task-blocking.ts";

export {
  assessTransitionDocument,
  assertTransitionDocumentReady,
  requireTransitionDocumentKind,
} from "./transition-document-readiness.ts";
export type { TransitionDocumentMissingSection } from "./transition-document-readiness.ts";

export { freshnessReasonOf } from "./decision-coverage.ts";
export type { FreshnessReason, FreshnessReasonInput } from "./decision-coverage.ts";

export { assessFactRetirement, validFactStillHoldsAttestation } from "./fact-retirement-readiness.ts";
export type { FactRetirementAssessment, FactStillHoldsAttestation } from "./fact-retirement-readiness.ts";

export { summarizeWorkspace, workspaceTaskStatus } from "./workspace-summary.ts";

export {
  taskBoardPlacement,
  taskCapabilities,
  taskPhase,
  taskPhaseSteps,
  taskRisk,
  taskVisibility,
} from "./task-board-projection.ts";
export type {
  TaskBoardColumnId,
  TaskCapabilityId,
  TaskCapabilityReason,
  TaskPhaseReason,
} from "./task-board-projection.ts";

export {
  DEFAULT_TASK_ROOT_THRESHOLD,
  DEFAULT_TASK_WIP_LIMIT,
  admitTaskExecutionWip,
  deriveTaskRoot,
  hasCloseoutEvidence,
  parseTaskWipLimit,
  taskWipOccupyingStatuses,
} from "./task-wip-policy.ts";
export type { TaskWipSnapshotEntryV1 } from "./task-wip-policy.ts";

export { findEntityRefs, parseEntityRef } from "./entity-ref.ts";
export type { EntityRef, EntityRefKind, ParsedEntityRef } from "./entity-ref.ts";

export { projectDeclaredRoleBindings, roleBindingActorMatches, roleBindingExpired } from "./role-binding.ts";
export type { RoleBinding } from "./role-binding.ts";
export type { DelegatedExecutionToken } from "./delegated-execution-token.ts";

export {
  decisionEntityId,
  decisionIdFromEntityId,
  moduleEntityId,
  moduleKeyFromEntityId,
  parseWriteEntityId,
  taskEntityId,
  taskIdFromEntityId,
} from "./entity-id.ts";
export type { EntityId, ParsedWriteEntityId } from "./entity-id.ts";

export {
  compileDecisionWrite,
  decisionDocumentProse,
  decisionMachineDigest,
  decisionStates,
  decisionWritePlan,
  reduceDecisionDocument,
} from "./decision-event.ts";
export type {
  DecisionAmendableSnapshot,
  DecisionDocumentState,
  DecisionEventV1,
  DecisionState,
} from "./decision-event.ts";
export {
  compileFactWrite,
  factConfidenceLevels,
  factMemoryClasses,
  factMemoryTags,
  factWritePlan,
  isFactId,
  validateFactEvent,
} from "./fact-event.ts";
export { validDomainType } from "./fact-event.ts";
export type { FactConfidence, FactDomainType, FactEventV1, FactMemoryClass, FactMemoryTag } from "./fact-event.ts";

export { CONTRACT_VERSION_1_0, isContractVersion, isContractVersionCompatible } from "./contract-version.ts";
export type { ContractVersion } from "./contract-version.ts";
export { normalizePersistedTimestamp, timestamp } from "./timestamp.ts";

export {
  getExecutableEntityAction,
  getEntityKindContract,
  getTaskActionForTransition,
  requireEntityStoreKindContract,
} from "./entity-kind-registry.ts";
export type { EntityActionContract, EntityActionInputField, EntityResidencyFacets } from "./entity-kind-registry.ts";
// 只导出有消费者的两个:目录构造与结果校验。schema id / 序列化 / 错误类型由
// daemon 的 schema registry 按路径引用(与 entity-action-explanation 同一惯例),
// 不进 kernel 公共面。
export { buildEntityKindCatalog, validateEntityKindCatalog } from "./entity-kind-catalog.ts";
export type { EntityKindCatalogV1 } from "./entity-kind-catalog.ts";

export { deriveUseCaseProjectionInputs } from "./use-case-projection-catalog.ts";
export type { UseCaseProjectionName } from "./use-case-projection-catalog.ts";

export { projectBaseEntityAtCut, requireEntityTypeContract } from "./base-entity.ts";
export type { BaseEntity } from "./base-entity.ts";
export { compiledRelationDirections, compileVerticalContract } from "./vertical-contract.ts";
export type { CompiledArtifactKindContract, CompiledVerticalContract } from "./vertical-contract.ts";
export { composeCanonicalRelationDirections } from "./relation-direction.ts";
export type { CanonicalRelationDirection } from "./relation-direction.ts";
export type {
  EntityActionCriterionFailure,
  EntityActionCompileInput,
  EntityActionDraft,
  EntityActionExecutionContract,
} from "./entity-action-execution.ts";
export { attributeEntityActionCriterion, entityActionCriterionFailure } from "./entity-action-execution.ts";
export { runtimeSessionActionIds, runtimeSessionActionPayload } from "./runtime-session-action-contract.ts";
export type { RuntimeSessionActionDraft } from "./runtime-session-action-contract.ts";
export { squadActionUsage } from "./squad-action-contract.ts";

export {
  canonicalRelationIdentityInput,
  deriveRelationId,
  isAllowedRelationKindTriple,
  normalizeLegacyRelationState,
  relationDirections,
  relationOrigins,
  relationIsCurrent,
  relationStates,
  relationStrengths,
  relationStrengthForType,
  relationTypes,
} from "./entity-relation.ts";
export { isRelationEvent, relationEventWritePlan, relationRecord } from "./relation-event.ts";
export type {
  EntityRelationRecord,
  EntityRelationValidationIssue,
  EntityRelationValidationIssueCode,
  RelationDirection,
  RelationOrigin,
  RelationState,
  RelationStrength,
  RelationType,
} from "./entity-relation.ts";
export {} from "./entity-freshness.ts";
export type {} from "./entity-freshness.ts";
export { deriveTaskReadSet } from "./task-read-set.ts";
export type { TaskReadSet, TaskReadSetCounterpart } from "./task-read-set.ts";

export { normalizeDomainError } from "./errors.ts";
export type {
  ArtifactStoreError,
  BindingInvariantError,
  CoreDomainError,
  EngineError,
  TemplateLibraryError,
} from "./errors.ts";

export { createScheduleV1, nextScheduleOccurrence, validateScheduleV1 } from "./schedule.ts";
export type {
  ScheduleActiveRunV1,
  ScheduleLastRunV1,
  ScheduleMissedReason,
  ScheduleRunOutcome,
  ScheduleTriggerV1,
  ScheduleV1,
} from "./schedule.ts";
export { compileScheduleDefinitionEvent, compileScheduleRunEvent, isScheduleEvent } from "./schedule-event.ts";
export type { ScheduleActionDraft } from "./schedule-action-contract.ts";

export {
  INITIAL_SETTINGS_V1,
  SETTINGS_ID,
  SETTINGS_LOCAL_PATH,
  parseLocalSettings,
  readSettingsFacet,
  repositorySettings,
  serializeLocalSettings,
  validateRepositorySettings,
  validateSettingsV1,
  writeRepositorySettingsFacet,
} from "./settings.ts";
export type { RepositorySettingsV1, SettingsLocale, SettingsV1 } from "./settings.ts";
export { compileSettingsChangedEvent, isSettingsEvent } from "./settings-event.ts";
export {
  applyVerticalKindCommand,
  compileVerticalDeclarationEvent,
  parseVerticalDeclarationDocument,
} from "./vertical-declaration.ts";
export { decodeVerticalDefinition } from "../schemas/vertical-definition.ts";
export type { VerticalDefinition } from "../schemas/vertical-definition.ts";
export { buildVerticalDeclarationRead, validateVerticalDeclarationRead } from "./vertical-declaration.ts";
export { settingsActionLocale } from "./settings-action-contract.ts";
export type { SettingsActionDraft } from "./settings-action-contract.ts";
export {
  applyPeopleRosterAction,
  mergePeopleRosterDocuments,
  parsePeopleRosterDocument,
  PEOPLE_ROSTER_PATH,
} from "./people-roster.ts";
export type {
  CredentialKind,
  CredentialRef,
  PeopleCommandClass,
  PeopleRosterDocumentV1,
  PersonProfile,
  RolePolicy,
} from "./people-roster.ts";
export { compilePeopleRosterActionEvent, isPeopleEvent, type CompiledPeopleRosterAction } from "./people-event.ts";
export {
  evaluatePersonActionCapability,
  personActionCriterionRef,
  personActionIds,
  personActionUsage,
  type PersonActionId,
} from "./person-action-contract.ts";

export {
  entityNonEmpty,
  entitySlug,
  parseAgentDeclarationV1,
  parseSquadDeclarationV1,
  validateAgentDeclarationV1,
  validateSquadDeclarationV1,
} from "./agent-squad-schema.ts";
export type {
  AgentDeclarationV1,
  AgentEntityKind,
  AgentFallbackDeclarationV1,
  AgentRole,
  AgentSkillDeclarationV1,
  SquadDeclarationV1,
} from "./agent-squad-schema.ts";
export { EntitySchemaContractError } from "./entity-json-schema.ts";
export { artifactEntityImportActionInput } from "./artifact-entity-actions.ts";

export {
  compileEntityContentObserved,
  compileEntityArchived,
  compileEntityUpdated,
  compileEntityTargetMissing,
  compileEntityUpsert,
  contractForDeclarationEvent,
  entityUpsertWritePlan,
  isEntityDeclarationEvent,
  isEntityEvent,
} from "./entity-event.ts";
export type {
  EntityContentObservedBundle,
  EntityEventV1,
  EntityTargetMissingBundle,
  EntityUpsertBundle,
} from "./entity-event.ts";
export {
  artifactEntityContractSnapshot,
  artifactImportOperationId,
  artifactObservationId,
  artifactUpdateOperationId,
  canonicalArtifactLocator,
  canonicalSourceIdentity,
  decodeArtifactDescriptor,
  deriveArtifactContentVersion,
  deriveArtifactEntityId,
} from "./artifact-entity.ts";
export type {
  ArtifactContentWitness,
  ArtifactDescriptor,
  ArtifactLocator,
  ArtifactSourceIdentityInput,
} from "./artifact-entity.ts";
export type { CiRunObservationEventV1 } from "./ci-run-observation-event.ts";
export { ciRunObservationWritePlan, validateCurrentCiRunObservationEvent } from "./ci-run-observation-event.ts";
