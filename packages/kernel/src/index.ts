export * from "./domain/index.ts";
export { applyTransition, decideTaskLifecycleWrite, freezeWritePlan, normalizeTaskLifecycleCommand, taskLifecycleWritePlan } from "./domain/task-lifecycle.contract.ts";
export type { CompleteTaskProof, ProofFor, StartExecutionProof, TaskEventV1, TaskLifecycleCommand, TaskLifecycleSnapshot } from "./domain/task-lifecycle.contract.ts";
export { canonicalizeContractValue } from "./domain/task.ts";
export type { FrozenWritePlan, TaskV1, WriteTarget } from "./domain/task.ts";
export type { LeaseV1 } from "./domain/execution.ts";
export { assertCurrentWriter, createWriteReceipt, issueWriterGenerationToken, normalizeCommandEnvelope, nextRecoveryBatch, RECOVERY_BUDGET, serializeEventEnvelope, serializeEventHead, validateWriteReceipt, writeReceiptOutcomes, WriteChainContractError } from "./domain/write-chain.contract.ts";
export type { EventHead, NormalizedCommandEnvelope, RecoveryBudget, WriteOperationReceipt, WriteReceipt, WriterGeneration, WriterGenerationToken, WriterPort } from "./domain/write-chain.contract.ts";
export * from "./docmap/index.ts";
export * from "./docmap/docmap-unique.ts";
export * from "./entity/disposition.ts";
export * from "./entity/field-contracts.ts";
export * from "./entity/registry.ts";
export {
  readSessionEntityDocument,
  writeSessionEntity
} from "./entity/session.ts";
export type { SessionManifest } from "./schemas/session-manifest.ts";
export { sha256Text, stablePayloadHash, stableStringify } from "./integrity/stable-hash.ts";
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
export * from "./ports/artifact-store-writer.ts";
export * from "./ports/index.ts";
export * from "./projection/post-merge-checks.ts";
export * from "./projection/relation-graph-projection.ts";
export {
  auditTaskProvenance,
  queryExecutionProjection,
  queryExecutionsByTask,
  queryReviewProjection,
  querySessionExecutionTrace,
  querySessionProjection,
  queryTaskExecutionTrace
} from "./projection/entity-projection-readers.ts";
export * from "./publish/index.ts";
export * from "./projection/sqlite-task-projection.ts";
export * from "./schemas/registry.ts";
export * from "./schemas/common.ts";
export * from "./schemas/docmap.ts";
export {
  makeJournaledWriteCoordinator,
  makeLocalLockRegistry,
  makeMarkdownArtifactStore,
  makeTaskEventStore,
  makeTaskLeaseStore,
  makeTaskProjection,
  readContentAddressedTextBlob,
  writeContentAddressedBlob
} from "./composition/index.ts";
export { writeCoordinatedPayload, writeCoordinatedTaskDocuments } from "./write-coordination/write-helpers.ts";
export {
  readDaemonRegistry,
  resolveDaemonRepoByRoot,
  registerDaemonRepo,
  unregisterDaemonRepo
} from "./daemon/registry.ts";
export type { DaemonRegistry, DaemonRegistryRepo } from "./daemon/registry.ts";
