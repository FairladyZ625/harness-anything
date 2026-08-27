export { createTaskIdentity } from "./task.ts";
export { currentActionEnvelopeVersion } from "./action-envelope.ts";
export type { ActionEnvelope } from "./action-envelope.ts";
export type { AuthorizationDecision } from "./receipt-frame.ts";
export { DEFAULT_POLICY } from "./default-policy.ts";
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

export { approvedReviewsForCut, consentedApprovedReview, reviewVerdicts } from "./review.ts";
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

export { freshnessReasonOf } from "./decision-coverage.ts";
export type { FreshnessReason, FreshnessReasonInput } from "./decision-coverage.ts";

export { summarizeWorkspace, workspaceTaskStatus } from "./workspace-summary.ts";

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

export { deriveRoleBindings, roleBindingActorMatches, roleBindingApplies, roleBindingExpired } from "./role-binding.ts";
export type { RoleBinding } from "./role-binding.ts";
export { deriveOwnerRoleBinding } from "./owner-role-binding.ts";
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
} from "./decision-event.ts";
export type {
  DecisionAmendableSnapshot,
  DecisionEventDraftV1,
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
} from "./fact-event.ts";
export type { FactConfidence, FactEventDraftV1, FactEventV1, FactMemoryClass, FactMemoryTag } from "./fact-event.ts";

export { CONTRACT_VERSION_1_0, isContractVersion, isContractVersionCompatible } from "./contract-version.ts";
export type { ContractVersion } from "./contract-version.ts";
export { normalizePersistedTimestamp, timestamp } from "./timestamp.ts";

export {
  createEntityKindRegistry,
  explainEntityKind,
  getEntityKind,
  getEntityKindContract,
  requireEntityKindContract,
  requireEntityStoreKindContract,
} from "./entity-kind-registry.ts";
export type {
  EntityKindDeclaration,
  EntityKindRegistration,
  EntityKindRegistry,
  EntityPackageScaffold,
  EntityResidencyFacets,
  EntityRepositoryRootScaffold,
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
  validateRelationRecordsForHost,
} from "./entity-relation.ts";
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

export type { EngineError, BindingInvariantError, ArtifactStoreError, TemplateLibraryError } from "./errors.ts";

export {
  createScheduleV1,
  nextScheduleOccurrence,
  scheduleMissedReasons,
  scheduleRunOutcomes,
  updateScheduleV1,
  validateScheduleV1,
} from "./schedule.ts";
export type { ScheduleMissedReason, ScheduleRunOutcome, ScheduleV1 } from "./schedule.ts";
export {
  compileScheduleDefinitionEvent,
  compileScheduleDeletedEvent,
  compileScheduleRunEvent,
  isScheduleEvent,
} from "./schedule-event.ts";

export {
  INITIAL_SETTINGS_V1,
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
export { compileSettingsChangedEvent } from "./settings-event.ts";
export {
  applyPeopleRosterAction,
  credentialKinds,
  mergePeopleRosterDocuments,
  parsePeopleRosterDocument,
  PEOPLE_ROSTER_PATH,
  peopleCommandClasses,
} from "./people-roster.ts";
export type {
  CredentialKind,
  CredentialRef,
  PeopleCommandClass,
  PeopleRosterAction,
  PersonProfile,
  RolePolicy,
} from "./people-roster.ts";
export { compilePeopleRosterActionEvent } from "./people-event.ts";

export { isEntityEvent } from "./entity-event.ts";
export type { CiRunObservationEventV1 } from "./ci-run-observation-event.ts";
export { ciRunObservationWritePlan, validateCurrentCiRunObservationEvent } from "./ci-run-observation-event.ts";

export {
  validateExtensionInputShape,
  validateTemplateCatalog,
  validateVerticalDefinition,
  planTemplateMaterialization,
  formatTemplateRef,
} from "./extension-model.ts";
export type {
  ExtensionValidationIssue,
  ExtensionValidationResult,
  MaterializationRequest,
  MaterializedTemplatePlan,
  MaterializationResult,
  ExtensionInputKind,
  TemplateBodyResolver,
} from "./extension-model.ts";
