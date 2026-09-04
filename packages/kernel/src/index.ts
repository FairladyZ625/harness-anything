export { consumeKnownError } from "./error-consumption.ts";
export * from "./domain/index.ts";
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
  runtimeTaskExecutionRelation,
  sessionProvenance,
  unavailableSessionIdentity,
} from "./domain/agent-runtime.ts";
export type {
  AgentDefinitionSnapshot,
  AgentRuntimeEventV1,
  RuntimeInstallation,
  RuntimeInstallationState,
  RuntimeKind,
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
  taskLifecycleWritePlan,
} from "./domain/task-lifecycle-publication.ts";
export { completionBlockers, type CompletionReadinessContext } from "./domain/completion-readiness.ts";
export { compileCompletionGateWitness } from "./domain/completion-gate-publication.ts";
export { reduceTaskEvent } from "./domain/task-lifecycle.contract.ts";
export type {
  CompleteTaskProof,
  ProofFor,
  TaskEventV1,
  TaskLifecycleCommand,
  TaskLifecycleSnapshot,
} from "./domain/task-lifecycle.contract.ts";
export { canonicalizeContractValue, currentTaskForWrite, taskClasses, validateTaskV2 } from "./domain/task.ts";
export type { TaskClass, TaskMetadataV1, TaskV2 } from "./domain/task.ts";
export {
  assertTaskBootstrapWritePlan,
  isTaskBootstrapEvent,
  taskBootstrapClaims,
  taskBootstrapWritePlan,
  validateTaskBootstrapEvent,
} from "./domain/task-bootstrap-event.ts";
export type {
  InitialDocumentClaim,
  PresetSnapshotClaim,
  TaskBootstrapBlob,
  TaskBootstrapEventV1,
  TaskDocumentOwner,
} from "./domain/task-bootstrap-event.ts";
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
  createWriteReceipt,
  isReceiptDiagnostic,
  normalizeCommandEnvelope,
  serializeEventHead,
  WRITE_RECEIPT_SCHEMA,
  sameWriteSource,
  isRecord,
} from "./domain/write-chain.contract.ts";
export type {
  ActorIdentity,
  DocSyncReceiptDetail,
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
  docByteLength,
  docSyncWritePlan,
  documentPath,
  isDocEvent,
  isFactEvent,
  isTaskEvent,
  parseDocWriteIntent,
  resolveDocRoute,
} from "./domain/doc-sync.contract.ts";
export {
  classifyTextualArtifactPath,
  OPAQUE_TEXTUAL_POLICY_ID,
  type OpaqueTextualMediaType,
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
  DocumentState,
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
  ArchivedExecutionV0,
  ExecutionV1,
  LeaseV1,
  ProjectedExecution,
  SubmissionV1,
} from "./domain/execution.ts";
export { submissionDigest } from "./domain/execution.ts";
export { sha256Bytes, sha256Text, stablePayloadHash, stableStringify } from "./integrity/stable-hash.ts";
export {
  contentObjectRelativePath,
  eventObjectRelativePath,
  eventObjectTarget,
} from "./layout/ledger-object-layout.ts";
export { isLedgerLayoutMigrationEvent } from "./domain/ledger-layout-migration-event.ts";
export {
  assertNoPortablePathCollisions,
  createHarnessRuntimeContext,
  findPortablePathCollisions,
  findTaskIdByExternalRef,
  findTaskPackagePath,
  generateTaskId,
  harnessRuntimeRoot,
  listTaskIndexPaths,
  normalizeRelativeDocumentPath,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  settingBlockValue,
  slugifyTaskTitle,
  taskDocumentPath,
  taskPackagePath,
  validateTaskIdSyntax,
} from "./layout/index.ts";
export type {
  HarnessLayout,
  HarnessLayoutInput,
  HarnessLayoutOverrides,
  HarnessRuntimeContext,
} from "./layout/index.ts";
export * from "./markdown/frontmatter.ts";
export * from "./ports/index.ts";
export { detectRelationGraphCycles } from "./projection/relation-graph-projection.ts";
export type {
  FactAnchorRow,
  RelationCoverageRow,
  RelationFactRow,
  RelationGraphEdgeRow,
  RelationGraphProjection,
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
export * from "./publish/index.ts";
export type {
  CoordinationStatus,
  ProjectionCanonicalStatus,
  ProjectionFreshness,
  ProjectionReadResult,
  ProjectionSource,
  ProjectionWarning,
  ProjectionWarningCode,
  ProjectionWarningSeverity,
  ProjectionWarningSource,
  TaskFieldExtensionProjection,
  TaskProjectionOptions,
  TaskProjectionRow,
} from "./projection/types.ts";
export * from "./schemas/registry.ts";
export * from "./schemas/common.ts";
export {
  createTaskCloseoutPacketTemplate,
  taskCloseoutPacketSchema,
  validateTaskCloseoutPacket,
} from "./schemas/task-closeout-packet.ts";
export type { CloseoutCiJudgment, TaskCloseoutPacket } from "./schemas/task-closeout-packet.ts";
export {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
  canonicalEventCut,
  canonicalEventWritePlan,
  configureLedgerMaintenance,
  localGitObjectRefStore,
  localGitWorktreeSettlement,
  createEntityStore,
  ledgerGitPath,
  makeGitEventStore,
  makeTaskEventReader,
  openEntityStore,
  resolveLedgerGitLayout,
  resolveRetirableDocument,
  eventShapeMigrations,
  runDispatchRecordMigration,
  makeTaskEventStore,
  makeTaskProjection,
  runEventShapeMigration,
  makeTaskProjectionReader,
  runWalMaterializationRequest,
} from "./composition/index.ts";
export type {
  CanonicalContentBlob,
  CanonicalEventAppendReceipt,
  CanonicalEventCut,
  CanonicalEventStore,
  CanonicalWriteBundle,
  DispatchRecordLeaseSettlement,
  PublicationFile,
  EntityStore,
  EventPublicationKillpoint,
  MaterializationHealth,
  MaterializationState,
  ProjectionPage,
  ReplicaProjectionBasis,
  TaskIndexProjectionRow,
  TaskProjection,
  TaskProjectionQueries,
  TaskProjectionListQuery,
  TaskRelationProjectionRead,
  TaskRelationNeighborhoodQuery,
  TaskRelationQuery,
  WalMaterializationFenceV1,
  WalRecoveryProgress,
} from "./composition/index.ts";
export {
  readDaemonRegistry,
  registerDaemonConnection,
  resolveDaemonRepoByRoot,
  registerDaemonRepo,
  removeDaemonConnection,
  unregisterDaemonRepo,
  updateDaemonConnection,
  updateDaemonRepo,
} from "./daemon/registry.ts";
export type {
  DaemonRegistry,
  DaemonRegistryConnection,
  DaemonRegistryRepo,
  DaemonRepoMode,
  InvalidDaemonRegistryRepo,
} from "./daemon/registry.ts";
