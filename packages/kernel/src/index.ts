export * from "./domain/index.ts";
export { applyTransition, normalizeTaskLifecycleCommand, validateTaskLifecycleCommandEnvelope } from "./domain/task-lifecycle.contract.ts";
export { taskLifecycleWritePlan } from "./domain/task-write-decision.ts";
export type { CompleteTaskProof, ProofFor, TaskEventV1, TaskLifecycleCommand, TaskLifecycleSnapshot } from "./domain/task-lifecycle.contract.ts";
export { canonicalizeContractValue } from "./domain/task.ts";
export type { TaskV1 } from "./domain/task.ts";
export { assertCurrentWriter, bindWriterGenerationToken, createWriteReceipt, normalizeCommandEnvelope, WRITE_RECEIPT_SCHEMA } from "./domain/write-chain.contract.ts";
export type { ActorIdentity, DocSyncReceiptDetail, FrozenWritePlan, WriteOperationReceipt, WriteReceipt, WriteSource, WriteTarget, WriterGeneration, WriterGenerationToken } from "./domain/write-chain.contract.ts";
export { DOC_POLICY_ID, decideDocWrite, docSyncWritePlan, documentPath, isDocEvent, parseDocWriteIntent, resolveDocRoute } from "./domain/doc-sync.contract.ts";
export type { DocClaimRef, DocEventV1, DocWriteIntent, LedgerCommitSha } from "./domain/doc-sync.contract.ts";
export * from "./docmap/index.ts";
export * from "./docmap/docmap-unique.ts";
export * from "./entity/disposition.ts";
export * from "./entity/field-contracts.ts";
export * from "./entity/registry.ts";
export { sha256Bytes, sha256Text, stablePayloadHash, stableStringify } from "./integrity/stable-hash.ts";
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
export * from "./ports/index.ts";
export * from "./projection/post-merge-checks.ts";
export * from "./projection/relation-graph-projection.ts";
export * from "./publish/index.ts";
export * from "./projection/sqlite-task-projection.ts";
export * from "./schemas/registry.ts";
export * from "./schemas/common.ts";
export * from "./schemas/docmap.ts";
export {
  makeTaskEventStore,
  makeTaskProjection,
  makeMarkdownArtifactStore
} from "./composition/index.ts";
export type { CanonicalEventStore, EventPublicationKillpoint, TaskProjection } from "./composition/index.ts";
export {
  readDaemonRegistry,
  resolveDaemonRepoByRoot,
  registerDaemonRepo,
  unregisterDaemonRepo
} from "./daemon/registry.ts";
export type { DaemonRegistry, DaemonRegistryRepo } from "./daemon/registry.ts";
