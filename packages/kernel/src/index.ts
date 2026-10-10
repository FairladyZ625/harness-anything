export { consumeKnownError } from "./error-consumption.ts";
export * from "./domain/index.ts";
export {
  activateEmptyCanonicalGeneration,
  convertLegacyGeneration,
  createImmutableLegacyGenerationSnapshot,
  legacyGenerationSnapshotPath,
} from "./composition/index.ts";
export {
  compareRuntimeActivity,
  latestRuntimeActivityAt,
  runtimeArchiveText,
  runtimeDefinitionSnapshotArtifact,
  runtimeEventContentClaims,
  runtimeSessionInActivityWindow,
  runtimeSessionIsRunning,
  runtimeSessionMissingOutcomeEvidence,
  runtimeSessionOutcomeFromEvidence,
  runtimeSessionSemanticState,
  sessionProvenance,
  unavailableSessionIdentity,
} from "./domain/agent-runtime.ts";
export type {
  AgentDefinitionSnapshot,
  AgentRuntimeEventV1,
  RuntimeInstallation,
  RuntimeInstallationState,
  RuntimeKind,
  RuntimeKindId,
  RuntimeProtocolFamily,
  RuntimeResultClaim,
  RuntimeSession,
  RuntimeSessionSemanticState,
  SessionIdentity,
  SessionIdentityResolver,
  SessionIdentityResolverInput,
} from "./domain/agent-runtime.ts";
export {
  allowsTaskStatusMove,
  applyTransition,
  canonicalCodeDocPaths,
  canonicalGateReceipts,
  canStartExecution,
  compileExecutionAnnotation,
  compileExecutionExecutorDeclaration,
  codeDocRecordId,
  currentCodeDocWitness,
  executionExecutorDeclarationCandidates,
  heldLeaseForExecutionActor,
  normalizeTaskLifecycleCommand,
  requiredGateWitnessCount,
  reviewDigest,
  validateTaskEvent,
  validateTaskLifecycleCommandEnvelope,
} from "./domain/task-lifecycle.contract.ts";
export { isIndependentFrom, isSameExecution, isSamePerson } from "./domain/actor-domain-services.ts";
export { revisionIssues } from "./domain/task-lifecycle-contract-support.ts";
export {
  isTaskBoundRuntimeWriter,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  taskIsDescendantOf,
} from "./domain/task-bound-runtime-authority.ts";
export type { TaskBoundRuntimeBinding } from "./domain/task-bound-runtime-authority.ts";
export {
  compileTaskLifecycleWrite,
  lifecycleDocumentFetchPaths,
  lifecycleDocumentPaths,
  rematerializeTaskDocuments,
  taskLifecycleWritePlan,
} from "./domain/task-lifecycle-publication.ts";
export type { LifecycleDocumentState } from "./domain/task-lifecycle-publication.ts";
export {
  completionBlockers,
  completionPreparationBlockers,
  taskCompletionNext,
  taskCompletionAction,
  completionGuidance,
  type CompletionReadinessContext,
} from "./domain/completion-readiness.ts";
export { compileCompletionGateWitness } from "./domain/completion-gate-publication.ts";
export { reduceTaskEvent } from "./domain/task-lifecycle.contract.ts";
export type {
  ProofFor,
  TaskEventV1,
  TaskLifecycleCommand,
  TaskLifecycleSnapshot,
} from "./domain/task-lifecycle.contract.ts";
export {
  canonicalizeContractValue,
  currentTaskForWrite,
  isWorkRoot,
  retiredTaskClassRestatements,
  taskClasses,
  validateTaskV2,
} from "./domain/task.ts";
export type { TaskClass, TaskMetadataV1, TaskV2 } from "./domain/task.ts";
export {
  isTaskBootstrapEvent,
  taskBootstrapWritePlan,
  validateTaskBootstrapEvent,
} from "./domain/task-bootstrap-event.ts";
export type { TaskBootstrapBlob, TaskBootstrapEventV1, TaskDocumentOwner } from "./domain/task-bootstrap-event.ts";
export {
  presetSnapshotUpgradeWritePlan,
  validatePresetSnapshotUpgradeEvent,
} from "./domain/preset-snapshot-upgrade-event.ts";
export type {
  PresetSnapshotUpgradeBundle,
  PresetSnapshotUpgradeEventV1,
} from "./domain/preset-snapshot-upgrade-event.ts";
export { compileTaskProgress, isTaskProgressEvent, taskProgressWritePlan } from "./domain/task-progress-event.ts";
export type { TaskProgressEvidence, TaskProgressEventV1 } from "./domain/task-progress-event.ts";
export {
  assertCurrentWriter,
  bindWriterGenerationToken,
  isReceiptDiagnostic,
  normalizeCommandEnvelope,
  serializeEventHead,
  sameWriteSource,
  isRecord,
} from "./domain/write-chain.contract.ts";
export type {
  ActorIdentity,
  DocSyncReceiptDetail,
  EdgeReadFreshness,
  FrozenWritePlan,
  LedgerCutIdentity,
  ReceiptDiagnostic,
  WriteOperationReceipt,
  WriteReceipt,
  WriteReceiptDraft,
  WriteSource,
  WriteTarget,
  WriterGeneration,
  WriterGenerationToken,
} from "./domain/write-chain.contract.ts";
export {
  parseVerticalScriptAction,
  parseVerticalScriptPlan,
  parseVerticalScriptResult,
} from "./domain/vertical-script-action.ts";
export type {
  VerticalScriptActionV1,
  VerticalScriptChangeV1,
  VerticalScriptPlanV1,
  VerticalScriptResultV1,
} from "./domain/vertical-script-action.ts";
export {
  DOC_POLICY_ID,
  decideDocWrite,
  decideDocWriteCriteria,
  docSyncWritePlan,
  documentPath,
  isDocEvent,
  isTaskEvent,
  parseDocWriteIntent,
  resolveDocRoute,
} from "./domain/doc-sync.contract.ts";
export {
  artifactSubtreePath,
  classifyOpaqueTextualArtifactPath,
  classifyRawArtifactPath,
  classifyTextualArtifactPath,
  DOC_SYNC_INLINE_MAX_BYTES,
  isOpaqueTextualMediaType,
  type OpaqueTextualMediaType,
  OPAQUE_TEXTUAL_POLICY_ID,
  RAW_ARTIFACT_MAX_BYTES,
  RAW_ARTIFACT_MEDIA_TYPE,
  RAW_ARTIFACT_POLICY_ID,
  worktreeDocumentMediaType,
} from "./domain/artifact-text-classification.ts";
export {
  parseCanonicalEvent,
  serializeCanonicalEvent,
  serializePersistedCanonicalEvent,
  validateCurrentCanonicalEvent,
  isMigrationImportEvent,
  normalizePersistedCanonicalEvent,
} from "./domain/doc-sync.contract.ts";
export type {
  CanonicalEventV1,
  DocClaimRef,
  DocEventChange,
  DocEventV1,
  DocWriteIntent,
  PersistedCanonicalEventV1,
  RuntimeArchiveWriteScope,
} from "./domain/doc-sync.contract.ts";
export {
  MIGRATION_DOCUMENT_POLICY_ID,
  MIGRATION_IMPORT_SOURCE,
  canonicalMigrationProvenance,
  migrationImportWritePlan,
  validateCurrentMigrationImportEvent,
  validateMigrationImportEvent,
} from "./domain/migration-import-event.ts";
export type {
  MigrationArchivedEntityKind,
  MigrationDestinationPreimage,
  MigrationDocumentClaim,
  MigrationImportEventV1,
} from "./domain/migration-import-event.ts";
export type {
  ArtifactDelivery,
  ArchivedExecutionV0,
  ExecutionAnnotationKind,
  ExecutionDeliveryBaseline,
  ExecutionV1,
  LeaseV1,
  ProjectedExecution,
  SubmissionV1,
} from "./domain/execution.ts";
export {
  executionAnnotationKinds,
  isNativeCommitSha,
  isNativeExecution,
  submissionDigest,
} from "./domain/execution.ts";
export {
  CODE_DOC_GATE_ID,
  gateAppliesTo,
  gateAppliesToSubmission,
  gateGovernanceFields,
  gateWitnessMappingIssues,
  resolveCompletionContract,
} from "./domain/completion-contract.ts";
export type {
  GithubWitnessOptions,
  FrozenGateRequirement,
  GateWitnessMappingV1,
} from "./domain/completion-contract.ts";
export { isHumanAttestationWitness } from "./domain/completion-gate-witness.ts";
export { sha256Bytes, sha256Text, stableStringify } from "./integrity/stable-hash.ts";
export { eventObjectTarget } from "./layout/ledger-object-layout.ts";
export {
  normalizeRelativeDocumentPath,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  slugifyTaskTitle,
  validateTaskIdSyntax,
} from "./layout/index.ts";
export type { HarnessLayoutOverrides } from "./layout/index.ts";
export * from "./ports/index.ts";
export type {
  FactAnchorRow,
  RelationCoverageRow,
  RelationFactRow,
  RelationGraphEdgeRow,
} from "./projection/relation-graph-projection.ts";
export { projectDecisionReadiness } from "./projection/decision-readiness-projection.ts";
export type { DecisionListFilters, DecisionProjectionRow } from "./projection/decision-event-projection.ts";
export type { FactProjectionRow, FactSearchFilters } from "./projection/fact-event-projection.ts";
export { readLegacyMigrationSource } from "./projection/cold-rebuild-source.ts";
export type {
  ColdDecisionProjectionRow,
  ColdRebuildIssue,
  ColdRebuildSource,
} from "./projection/cold-rebuild-source.ts";
export {
  legacyRelationManualReason,
  normalizeLegacyRelationMigrationEvent,
} from "./projection/relation-migration-normalization.ts";
export { readMarkdownSource, taskEntryToRow } from "./projection/sqlite-task-source.ts";
export type { TaskSourceEntry } from "./projection/sqlite-task-source.ts";
export { renderDecisionDocument } from "./domain/decision-event.ts";
export { renderFactsDocument } from "./domain/fact-event.ts";
export type { ProjectionWarning, TaskProjectionRow } from "./projection/types.ts";
export {
  applyEdgeReadModelEntry,
  createEdgeReadModelTables,
  deleteEdgeReadModelEntry,
  edgeReadAuthorizationShapeDigest,
  isReadModelPath,
  parseEdgeReadModelMeta,
  READ_MODEL_META_PATH,
  READ_MODEL_SCHEMA_GENERATION,
} from "./projection/read-model.ts";
export type { EdgeReadModelMeta } from "./projection/read-model.ts";
export { canonicalJson } from "./projection/rebuildable-task-projection-sql.ts";
export { makeEdgeReplicaQueries, type EdgeReplicaQueries } from "./projection/edge-replica-queries.ts";
export { emptyTaskLifecycleSnapshot } from "./domain/task-lifecycle.contract.ts";
export { docByteLength } from "./domain/doc-sync-codec.ts";
export type { DocumentState } from "./domain/doc-sync-types.ts";
export { schemaRegistry, TemplateCatalogSchema } from "./schemas/registry.ts";
export type {
  WitnessSourceDefinition,
  CompletionGateDeclaration,
  VerticalCompletionDeclaration,
} from "./domain/completion-source.ts";
export { VerticalCompletionDeclarationSchema } from "./schemas/completion-source.ts";
export type { TemplateCatalog, TemplateSelection } from "./schemas/registry.ts";
export {
  decodeVerticalDefinition,
  parseVerticalDeclarationDocument,
  validateVerticalDeclarationRead,
} from "./schemas/vertical-definition.ts";
export {
  canonicalEventCut,
  canonicalEventWritePlan,
  createLedgerBackup,
  drillLedgerBackup,
  restoreLedgerBackup,
  configureLedgerMaintenance,
  HARNESS_LEDGER_WRITER_ENV,
  installLedgerCommitGuard,
  localGitWorktreeSettlement,
  localGitObjectRefStore,
  createEntityStore,
  ledgerGitPath,
  makeTaskEventReader,
  openEntityStore,
  resolveLedgerGitLayout,
  eventShapeMigrations,
  makeTaskEventStore,
  makeTaskProjection,
  openSqliteEventStore,
  readOfflineLedgerEvents,
  resolveActiveGeneration,
  restoreDrillRetentionFor,
  runGenerationTwoConversion,
  readCertifiedGitFollower,
  sqliteLedgerPath,
  reconcileSqliteEvents,
  makeTaskProjectionReader,
  applyLedgerBackupRetention,
  readVerifiedLedgerBackup,
} from "./composition/index.ts";
export type { LedgerBackupRetentionPolicyV1 } from "./composition/index.ts";
export type {
  CanonicalContentBlob,
  CanonicalEventAppendReceipt,
  CanonicalEventCut,
  CanonicalEventStore,
  CanonicalWriteBundle,
  DispatchRecordLeaseSettlement,
  EntityStore,
  EventPublicationKillpoint,
  MaterializationHealth,
  MaterializationState,
  ProjectionPage,
  TaskIndexProjectionRow,
  TaskProjection,
  TaskProjectionQueries,
  TaskProjectionListQuery,
  TaskRelationProjectionRead,
  TaskRelationNeighborhoodQuery,
  TaskRelationQuery,
} from "./composition/index.ts";
export {
  readDaemonRegistry,
  registerDaemonConnection,
  removeDaemonConnection,
  disableDaemonRepo,
  unbindDaemonRepo,
  updateDaemonConnection,
  updateDaemonRepo,
} from "./daemon/registry.ts";
export { registerDaemonRepo } from "./composition/index.ts";
export type {
  DaemonRegistry,
  DaemonRegistryConnection,
  DaemonRegistryRepo,
  DaemonRepoMode,
  InvalidDaemonRegistryRepo,
} from "./daemon/registry.ts";

export { validateReceiptAcceptance } from "./domain/receipt-acceptance.ts";

export {
  attachReceiptAcceptance,
  readAcceptedCommandOutcome,
  waitForReceiptAcceptance,
} from "./composition/receipt-acceptance.ts";

export {
  type TaskClaimScope,
  validTaskAssignment,
  taskAssignmentMatches,
  type TaskAssignment,
  type TaskClaimant,
} from "./domain/task-assignment.ts";

export type {
  SquadRunPhase,
  SquadDispatchContext,
  SquadRunObservation,
  CanonicalSquadRun,
} from "./domain/squad-run.ts";

export { validSquadDispatchContext } from "./domain/squad-run.ts";

export { publicRuntimeSession, publicRuntimeInstallation } from "./domain/runtime-public-query.ts";

export type { CanonicalEventSummary } from "./domain/canonical-event-summary.ts";

export type { EventListQuery } from "./domain/event-list.ts";

export { reduceArtifactEntityState, type ArtifactEntityState } from "./domain/artifact-entity-state.ts";

export {
  replicaManifestDigest,
  updateReplicaManifestDigest,
  type ReplicaSequenceRead,
  type ReplicaRevision,
} from "./projection/replica-sequence.ts";

export { currentGateRun, claimGateRun, settleGateRun, validCompletionWitnessResult } from "./domain/gate-run.ts";
export type { GateRun, CompletionWitnessResult } from "./domain/gate-run.ts";
export { completionPredicateIssues } from "./schemas/completion-predicate.ts";

export { compileGateRunChange } from "./domain/gate-run-publication.ts";
