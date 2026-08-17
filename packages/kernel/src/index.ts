export { consumeKnownError } from "./error-consumption.ts";
export * from "./domain/index.ts";
export { isAgentRuntimeEvent, runtimeSessionId } from "./domain/agent-runtime.ts"; export type { AgentDefinitionSnapshot, AgentRuntimeEventV1, RuntimeInstallation, RuntimeSession } from "./domain/agent-runtime.ts";
export { applyTransition, canonicalGateReceipts, canStartExecution, normalizeTaskLifecycleCommand, reviewDigest, validateTaskLifecycleCommandEnvelope } from "./domain/task-lifecycle.contract.ts";
export { canReclaim, isIndependentFrom, isSameExecution, isSamePerson } from "./domain/actor-domain-services.ts";
export { compileTaskLifecycleWrite, lifecycleDocumentPaths, taskLifecycleWritePlan } from "./domain/task-lifecycle-publication.ts";
export { completionBlockers, type CompletionReadinessContext } from "./domain/completion-readiness.ts";
export { compileCompletionGateWitness } from "./domain/completion-gate-publication.ts";
export { reduceTaskEvent } from "./domain/task-lifecycle.contract.ts";
export type { CompleteTaskProof, ProofFor, TaskEventV1, TaskLifecycleCommand, TaskLifecycleSnapshot } from "./domain/task-lifecycle.contract.ts";
export { canonicalizeContractValue, taskClasses } from "./domain/task.ts";
export type { TaskClass, TaskMetadataV1, TaskV1 } from "./domain/task.ts";
export { assertTaskBootstrapWritePlan, isTaskBootstrapEvent, taskBootstrapClaims, taskBootstrapWritePlan, validateTaskBootstrapEvent } from "./domain/task-bootstrap-event.ts";
export type { InitialDocumentClaim, PresetSnapshotClaim, TaskBootstrapBlob, TaskBootstrapEventV1, TaskDocumentOwner } from "./domain/task-bootstrap-event.ts";
export { presetSnapshotUpgradeWritePlan, validatePresetSnapshotUpgradeEvent } from "./domain/preset-snapshot-upgrade-event.ts";
export type { PresetSnapshotUpgradeBundle, PresetSnapshotUpgradeEventV1 } from "./domain/preset-snapshot-upgrade-event.ts";
export { compileTaskProgress, isTaskProgressEvent } from "./domain/task-progress-event.ts";
export type { TaskProgressEvidence, TaskProgressEventV1 } from "./domain/task-progress-event.ts";
export { assertCurrentWriter, bindWriterGenerationToken, createWriteReceipt, normalizeCommandEnvelope, serializeEventHead, WRITE_RECEIPT_SCHEMA } from "./domain/write-chain.contract.ts";
export type { ActorIdentity, DocSyncReceiptDetail, FrozenWritePlan, WriteOperationReceipt, WriteReceipt, WriteSource, WriteTarget, WriterGeneration, WriterGenerationToken } from "./domain/write-chain.contract.ts";
export { parseVerticalScriptAction, parseVerticalScriptPlan, parseVerticalScriptResult } from "./domain/vertical-script-action.ts"; export type { VerticalScriptActionV1, VerticalScriptChangeV1, VerticalScriptPlanV1, VerticalScriptResultV1 } from "./domain/vertical-script-action.ts";
export { DOC_POLICY_ID, decideDocWrite, docSyncWritePlan, documentPath, isDocEvent, isTaskEvent, parseDocWriteIntent, resolveDocRoute } from "./domain/doc-sync.contract.ts";
export { parseCanonicalEvent, serializeCanonicalEvent } from "./domain/doc-sync.contract.ts";
export type { CanonicalEventV1, DocClaimRef, DocEventV1, DocWriteIntent, LedgerCommitSha } from "./domain/doc-sync.contract.ts";
export { MIGRATION_DOCUMENT_POLICY_ID, MIGRATION_IMPORT_SOURCE, migrationImportWritePlan, validateMigrationImportEvent } from "./domain/migration-import-event.ts";
export type { MigrationDestinationPreimage, MigrationDocumentClaim, MigrationImportEventV1 } from "./domain/migration-import-event.ts";
export type { ArchivedExecutionV0, ExecutionV1, ProjectedExecution } from "./domain/execution.ts";
export * from "./entity/disposition.ts";
export * from "./entity/field-contracts.ts";
export * from "./entity/registry.ts";
export { sha256Bytes, sha256Text, stablePayloadHash, stableStringify } from "./integrity/stable-hash.ts";
export { eventObjectTarget } from "./layout/ledger-object-layout.ts";
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
  resolveEntityRoot,
  resolveHarnessLayout,
  setting,
  settingBlockValue,
  slugifyTaskTitle,
  taskDocumentPath,
  taskPackagePath,
  validateTaskIdSyntax
} from "./layout/index.ts";
export type {
  EntityRootIntent,
  EntityRootResolution,
  HarnessLayout,
  HarnessLayoutInput,
  HarnessLayoutOverrides,
  HarnessRuntimeContext
} from "./layout/index.ts";
export * from "./markdown/frontmatter.ts";
export * from "./ports/index.ts";
export * from "./projection/post-merge-checks.ts";
export { detectRelationGraphCycles, readRelationGraphAuthoredSourceKinds, validateRelationGraphRecords } from "./projection/relation-graph-projection.ts"; export type { FactAnchorRow, RelationCoverageRow, RelationFactRow, RelationGraphEdgeRow, RelationGraphProjection, RelationRecordEntry, RelationRecordValidationIssue } from "./projection/relation-graph-projection.ts";
export { projectDecisionReadiness } from "./projection/decision-readiness-projection.ts";
export type { DecisionListFilters, DecisionProjectionRow, FactProjectionRow, FactSearchFilters } from "./projection/fact-event-projection.ts";
export { buildColdCoverage, readColdRebuildSource } from "./projection/cold-rebuild-source.ts";
export type { ColdDecisionProjectionRow, ColdRebuildIssue } from "./projection/cold-rebuild-source.ts";
export { readMarkdownSource, taskEntryToRow } from "./projection/sqlite-task-source.ts";
export type { TaskSourceEntry } from "./projection/sqlite-task-source.ts";
export { renderDecisionDocument, renderFactsDocument } from "./domain/fact-event.ts";
export * from "./publish/index.ts";
export * from "./projection/sqlite-task-projection.ts";
export * from "./schemas/registry.ts";
export * from "./schemas/common.ts";
export {
  canonicalDocumentClaims, canonicalEventWritePlan, configureLedgerMaintenance, ledgerGitPath, resolveLedgerGitLayout,
  makeTaskEventStore,
  makeTaskProjection
} from "./composition/index.ts";
export type { CanonicalEventStore, CanonicalWriteBundle, EventPublicationKillpoint, ReplicaProjectionBasis, TaskProjection } from "./composition/index.ts";
export {
  readDaemonRegistry,
  resolveDaemonRepoByRoot,
  registerDaemonRepo,
  unregisterDaemonRepo
} from "./daemon/registry.ts";
export type { DaemonRegistry, DaemonRegistryRepo, InvalidDaemonRegistryRepo } from "./daemon/registry.ts";
