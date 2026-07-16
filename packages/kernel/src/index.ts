export * from "./domain/index.ts";
export { parseDecisionDocument } from "./domain/decision-document.ts";
export { executionStates } from "./domain/execution.ts";
export type {
  ExecutionRecord,
  ExecutionState,
  OutputEvidence
} from "./domain/execution.ts";
export { executionDeclaration } from "./entity/execution-declaration.ts";
export { consentDeclaration } from "./entity/consent-declaration.ts";
export { reviewDeclaration } from "./entity/review-declaration.ts";
export * from "./entity/disposition.ts";
export * from "./entity/field-contracts.ts";
export {
  assertManagedSemanticRegions,
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  entityRegistry,
  entityRegistryKinds,
  entityStorageForms,
  getEntityRegistration,
  isEntityStorageForm
} from "./entity/registry.ts";
export type {
  CompositeManifestBlobDeclaration,
  DispositionAction,
  DispositionLevel,
  DispositionMatrixEntry,
  EntityAnchorDeclaration,
  EntityDispositionMatrix,
  EntityDocumentCodec,
  EntityProjectionColumnDeclaration,
  EntityProjectionDeclaration,
  EntityRegistration,
  EntityRegistryShape,
  EntityRootResolverDeclaration,
  EntityStorageForm,
  HostedEntityDeclaration,
  KernelEntityKind,
  RegistryMutationPlanInput,
  SemanticDiffCandidateTree,
  SemanticDiffDocumentPolicy,
  SemanticDiffMutationIntent,
  StoragePlan
} from "./entity/registry.ts";
export {
  readSessionEntityDocument,
  writeSessionEntity
} from "./entity/session.ts";
export type { SessionManifest } from "./schemas/session-manifest.ts";
export { resolveEntityDocumentPath, writeDeclaredEntityTransaction } from "./entity/declaration.ts";
export { sha256Text, stablePayloadHash, stableStringify } from "./integrity/stable-hash.ts";
export { computeExecutionConsentPin } from "./integrity/execution-consent-pin.ts";
export {
  actorAxesBindingCoreDigestV2,
  actorAxesBindingCoreV2Domain
} from "./integrity/actor-axes-binding-integrity-v2.ts";
export type { ProtocolSchemaTupleV2Core } from "./integrity/actor-axes-binding-integrity-v2.ts";
export type { ActorAxesBindingCoreV2 } from "./integrity/actor-axes-binding-integrity-v2.ts";
export {
  canonicalCborBytesEqual,
  decodeCanonicalCbor,
  domainHash,
  encodeCanonicalCbor
} from "./integrity/canonical-cbor.ts";
export type { CanonicalCborValue } from "./integrity/canonical-cbor.ts";
export {
  semanticMutationSetBytesV2,
  semanticMutationSetDigestV2,
  semanticMutationSetV2Domain,
  semanticMutationSetWireV2,
  semanticMutationWireV2,
  validateSemanticMutationSetV2
} from "./integrity/semantic-mutation-integrity-v2.ts";
export type {
  RegisteredSemanticActionV2,
  RegistryEntityRefV2,
  SemanticMutationSetV2,
  SemanticMutationV2
} from "./integrity/semantic-mutation-integrity-v2.ts";
export {
  computeDecisionContentDigest,
  decisionContentCanonicalization,
  decisionContentDigestFields
} from "./integrity/decision-content-digest.ts";
export type { DecisionContentDigestField } from "./integrity/decision-content-digest.ts";
export { validateOutputEvidence } from "./local/output-evidence-validator.ts";
export { readUnionAttributionEvents } from "./local/attribution-event-source.ts";
export { makeCodeDocGitEvidenceResolver } from "./git/code-doc-git-evidence.ts";
export * from "./layout/index.ts";
export * from "./markdown/frontmatter.ts";
export { extractMarkdownSection, markdownHeadingSections } from "./markdown/section.ts";
export * from "./ports/artifact-store-writer.ts";
export * from "./ports/index.ts";
export * from "./projection/post-merge-checks.ts";
export * from "./projection/relation-flow-frontmatter.ts";
export * from "./projection/relation-graph-projection.ts";
export {
  auditTaskProvenance,
  queryExecutionProjection,
  queryExecutions,
  queryExecutionsByTask,
  queryReviewProjection,
  querySessionExecutionTrace,
  querySessionProjection,
  queryTaskExecutionTrace
} from "./projection/entity-projection-readers.ts";
export { queryExecutionEvidencePage } from "./projection/sqlite-execution-evidence-reader.ts";
export * from "./publish/index.ts";
export * from "./projection/sqlite-task-projection.ts";
export {
  materializeAttributionProjectionFromEvents,
  readModuleAttributionProjection,
  readAttributionProjection
} from "./projection/sqlite-attribution-projection.ts";
export type { EntityAttributionProjection } from "./projection/types.ts";
export * from "./schemas/registry.ts";
export * from "./schemas/common.ts";
export type {
  LogicalArtifactV1,
  PresetCapabilityRequirement,
  PresetEntrypointV3,
  PresetInputV3
} from "./schemas/preset-manifest-v3.ts";
export { RuntimeEventRecordV2Schema } from "./schemas/runtime-event.ts";
export type { RuntimeEventRecordDocument, RuntimeEventRecordV2 } from "./schemas/runtime-event.ts";
export type {
  ActorAxes,
  OperationalActor,
  PrincipalSource,
  WriteAttribution
} from "./schemas/actor-attribution.ts";
export type { AttributionEvent } from "./schemas/attribution-event.ts";
export type { UnionAttributionEvent } from "./schemas/attribution-event-union.ts";
export {
  canonicalAttributionEventDigestV2,
  decodeAndVerifyAttributionEventV2,
  physicalChangeSetDigestV2,
} from "./schemas/attribution-event-union.ts";
export type { AttributionEventV2, PhysicalChangeV2 } from "./schemas/attribution-event-union.ts";
export * from "./schemas/task-schema-resolver.ts";
export {
  makeJournaledWriteCoordinator,
  makeLocalAuthorityAttributionEventV2Log,
  makeOperationalJournaledWriteCoordinator,
  makeLocalLockRegistry,
  makeLocalVersionControlSystem,
  makeMarkdownArtifactStore,
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
export {
  TaskClaimCollisionError,
  ExecutionLeaseCollisionError,
  TaskLeaseRequiredError,
  TaskReleaseNotHolderError,
  isTaskHolderError,
  makeTaskHolderService,
  runtimeEventActorFromTaskHolderPrincipal,
  taskHolderActor,
  taskHolderExecutorFromJournalActor,
  taskHolderPrincipalFromActor
} from "./local/task-holder-state.ts";
export type {
  TaskHolderAcquiredVia,
  ExecutionLeaseContext,
  ExecutionLeaseRecord,
  ExecutionLeaseReservation,
  TaskHolderClaimResult,
  TaskHolderCredential,
  TaskHolderExecutor,
  TaskHolderPersonPrincipal,
  TaskHolderPrincipal,
  TaskHolderRecord,
  TaskHolderReleaseResult,
  TaskHolderService,
  TaskHolderServiceOptions,
  TaskHolderSnapshot
} from "./local/task-holder-state.ts";
