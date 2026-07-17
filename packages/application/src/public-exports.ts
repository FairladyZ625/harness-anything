// application 包的 re-export barrel。
// 它从 index.ts 分出来的唯一原因是 check-api-contract-registry 只解析 index.ts 的
// 文本声明(不跟随 re-export),所以 84 个契约类型必须留在 index.ts;而 check-file-complexity
// 卡 600 行。两道门夹住同一个文件 —— 搬走 barrel 是唯一不动门禁的出路。

export { commandReceiptEnvelope, failureReceiptNextActions } from "./command-receipt.ts";
export { compileTaskContractSnapshot, parseTaskContractSnapshot, resolveTaskCompletionGates } from "./task-contract-snapshot.ts";
export type { CompileTaskContractSnapshotInput, ResolveTaskCompletionGatesInput, ResolveTaskCompletionGatesResult } from "./task-contract-snapshot.ts";
export { analyzePresetUninstallImpact, evaluatePresetRuntimeAvailability } from "./preset-uninstall-impact.ts";
export type {
  PresetRuntimeAvailability,
  PresetRuntimeRequirement,
  PresetUninstallDecisionReason,
  PresetUninstallImpactEntry,
  PresetUninstallImpactReport,
  PresetUninstallTarget,
  PresetUninstallTaskReference
} from "./preset-uninstall-impact.ts";
export { readModuleAttributionProjection } from "../../kernel/src/index.ts";
export {
  authorityProtocolTuple,
  canonicalAuthorityRequestDigest,
  completeAuthorityCommittedReceiptV2,
  createDurableAuthorityCommittedEventPublisherV2,
  createAuthoritySubmissionService,
  makeCompositeAuthoritySemanticCompilerV2,
  createInMemoryShadowPublicationLog,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  isCompleteAuthorityCommittedReceiptV2,
  reconcileShadowPublications,
  shadowPublicationSchema,
  shadowReconciliationSchema,
  createAuthorityCutoverEntityRegistryQualification,
  createAuthorityCutoverControlService
} from "./authority/index.ts";
export type {
  AttributedCoordinatorFactory,
  AuthorityCommittedEventPublisherV2,
  AuthorityCommittedPhysicalObservationPortV2,
  AuthorityCommittedPhysicalObservationV2,
  AuthorityCommittedReceipt,
  AuthorityFenceWitness,
  AuthorityIndeterminateReceipt,
  AuthorityIntegrityTupleV2,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityOperationRecord,
  AuthorityStoredOperationRecord,
  AuthorityOperationRegistry,
  AuthorityOperationState,
  AuthorityProtocolTuple,
  AuthorityRejectedReceipt,
  AuthorityRetryableReceipt,
  AuthoritySemanticCompilerRouteV2,
  AuthoritySubmissionService,
  AuthoritySubmissionServiceOptions,
  CanonicalPublication,
  CanonicalPublicationInspector,
  DelegationTokenClaims,
  DelegationTokenVerification,
  DelegationTokenVerifier,
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "./authority/index.ts";
export type {
  AuthorityCutoverControlService,
  AuthorityProductionRepoScan
} from "./authority/cutover-control.ts";
export * from "./authority/actor-axes-binding-v2.ts";
export * from "./authority/key-registry-v1.ts";
export * from "./authority/canonical-cbor.ts";
export * from "./authority/semantic-mutation-envelope-v2.ts";
export * from "./authority/fact-relation-semantic-compiler-v2.ts";
export * from "./authority/task-decision-module-semantic-compiler-v2.ts";
export * from "./authority/session-execution-review-semantic-compiler-v2.ts";
export * from "./authority/consent-semantic-compiler-v2.ts";
export * from "./authority/transparent-semantic-diff-compiler-v2.ts";
export { compileManagedCandidateTreeV2 } from "./authority/semantic-authority-helpers-v2.ts";
export * from "./authority/committed-attribution-event-v2.ts";
export type { AuthoritySubmissionV2Options } from "./authority/service.ts";
export type {
  CanonicalPublicationObservation,
  ShadowDifference,
  ShadowDifferenceCode,
  ShadowPublicationLog,
  ShadowPublicationRecord,
  ShadowReconciliationReport
} from "./authority/index.ts";
export {
  classifyCompoundExit,
  compoundExitCodes,
  compoundExitDefinitions,
  CompoundReceiptTransitionError,
  compoundReceiptPhases,
  compoundReceiptSchema,
  createCompoundReceiptService,
  isCompoundOperationReceipt
} from "./receipt/index.ts";
export * from "./receipt/witness-v1.ts";
export * from "./receipt/v2-integrity.ts";
export * from "./receipt/v2-service.ts";
export * from "./receipt/v2-types.ts";
export * from "./receipt/validation-v2.ts";
export * from "./receipt/wire-v1.ts";
export type {
  AppliedExactAtCut,
  ApplyBlockedOrigin,
  CompoundExitCode,
  CompoundExitDefinition,
  CompoundExitInput,
  CompoundExitSymbol,
  CompoundOperationReceipt,
  CompoundReceiptPhase,
  CompoundReceiptService,
  CompoundReceiptServiceOptions,
  CompoundReceiptStore,
  CurrentLeaseState,
  ImmutableReceiptAcknowledgement,
  LocalConflictOrigin,
  NonquiescentOrigin,
  OriginResolution,
  ReceiptDeliveryState,
  ReceiptIdentity,
  SupersededOrigin,
  ViewUnavailableOrigin
} from "./receipt/index.ts";
export type { CommandFailureReceipt, CommandReceipt, CommandReceiptEnvelope, CommandReceiptNextAction } from "./command-receipt.ts";
export {
  compareCanonicalPathBytes,
  createNamespaceAdmissionService,
  foldPortableComponent,
  FoldedComponentTrie,
  NamespaceAdmissionError,
  portableAsciiV2,
  validatePortableManagedPath
} from "./namespace/index.ts";
export type {
  ExistingManagedPath,
  ManagedObjectKind,
  NamespaceAdmissionCode,
  NamespaceAdmissionService,
  PortablePathDescriptor,
  PortablePathOptions
} from "./namespace/index.ts";
export { CODE_DOC_RECONCILIATION_DOCUMENT, evaluateCodeDocReconciliationGate, renderCodeDocReconciliationDraft } from "./code-doc-reconciliation.ts";
export { currentSessionToProvenancePayload, defaultRuntimeSessionEnvCandidates, makeEnvironmentCurrentSessionProbe, makeHumanFallbackSessionProbe } from "./current-session-probe.ts";
export { bindCreateProvenance } from "./provenance-binding.ts";
export { makeDecisionWriteService } from "./decision-write-service.ts";
export { makeExecutionReservationReconciler, makeExecutionSagaService } from "./execution-saga-service.ts";
export { makeCoordinatedExecutionAuthoredStore } from "./coordinated-execution-authored-store.ts";
export { makeReviewExecutionService } from "./review-execution-service.ts";
export type { ReviewExecutionService } from "./review-execution-service.ts";
export { makeRecordExecutionConsentService } from "./record-execution-consent-service.ts";
export type { RecordExecutionConsentService } from "./record-execution-consent-service.ts";
export {
  DEFAULT_HUMAN_CONSENT_ACTIONS,
  DEFAULT_HUMAN_CONSENT_TTL_MS
} from "./execution-consent-helpers.ts";
export { makeExecutionCompletionService } from "./execution-completion-service.ts";
export type { ExecutionCompletionService } from "./execution-completion-service.ts";
export { makeFactWriteService } from "./fact-write-service.ts";
export {
  taskWriteApiRoutePolicies,
  taskWriteCliRoutePolicies,
  taskWriteCliRoutePolicy
} from "./task-write-route-policy.ts";
export type {
  ExecutionAuthoredStore,
  ExecutionClaimResult,
  ExecutionSagaService,
  ExecutionSagaServiceOptions,
  ExecutionSessionBinding,
  ExecutionSessionRole,
  ExecutionSubmission
} from "./execution-saga-service.ts";
export type {
  TaskWriteApiRoutePolicy,
  TaskWriteCliRoutePolicy,
  TaskWriteCommandClass
} from "./task-write-route-policy.ts";
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
} from "../../kernel/src/index.ts";
export { makeProvenanceSessionExporter } from "./provenance-session-exporter.ts";
export { readSessionEntity } from "./session-entity-reader.ts";
export type { SessionEntityReadResult } from "./session-entity-reader.ts";
export { classifyStaticZones, classifyTouchedZones, forbiddenTouchesForZones } from "./doc-sync.ts";
export { makeRuntimeEventAppendPromise, makeRuntimeEventLedgerService } from "./runtime-event-ledger-service.ts";
export { listDecisionDocuments, readDecisionDocument } from "./decision-document-reader.ts";
export type { CodeDocDocument, CodeDocReconciliationDraft, CodeDocReconciliationDraftInput, CodeDocReconciliationInput, CodeDocReconciliationIssue, CodeDocReconciliationResult, CodeDocReconciliationWarning } from "./code-doc-reconciliation.ts";
export type { EnvironmentCurrentSessionProbeOptions, HumanFallbackSessionProbeOptions, RuntimeSessionEnvCandidate } from "./current-session-probe.ts";
export type { ProvenanceBindingOptions } from "./provenance-binding.ts";
export type {
  DecisionDocumentListResult,
  DecisionDocumentReadResult
} from "./decision-document-reader.ts";
export type {
  DecisionCreateInput,
  DecisionAmendRequest,
  DecisionTransitionRequest,
  DecisionWriteRejected,
  DecisionWriteRequest,
  DecisionWriteResult,
  DecisionWriteService,
  DecisionWriteServiceOptions
} from "./decision-write-service.ts";
export type {
  FactInvalidateRequest,
  FactInvalidateResult,
  FactRecordRequest,
  FactWriteRejected,
  FactWriteResult,
  FactWriteService,
  FactWriteServiceOptions
} from "./fact-write-service.ts";
export type {
  ExecutionLeaseContext,
  ExecutionLeaseRecord,
  ExecutionLeaseReservation,
  TaskHolderAcquiredVia,
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
} from "../../kernel/src/index.ts";
export { executionDeclaration, executionStates, resolveEntityDocumentPath } from "../../kernel/src/index.ts";
export { makeJournaledWriteCoordinator, makeMarkdownArtifactStore } from "../../kernel/src/index.ts";
export type { ExecutionRecord, ExecutionState } from "../../kernel/src/index.ts";
export type {
  ProvenanceSessionBackfillOptions,
  ProvenanceSessionBackfillResult,
  ProvenanceSessionDocument,
  ProvenanceSessionExporter,
  ProvenanceSessionExportOptions,
  ProvenanceSessionExporterOptions,
  ProvenanceSessionExporterRejected,
  ProvenanceSessionExportResult
} from "./provenance-session-exporter.ts";
export type {
  DocSyncChangeV1,
  DocSyncConflictV1,
  DocSyncForbiddenTouchV1,
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1,
  DocSyncValidationResult
} from "./doc-sync.ts";
export type {
  RuntimeEventAppendInput,
  RuntimeEventExportPort,
  RuntimeEventLedgerAppendResult,
  RuntimeEventLedgerReadResult,
  RuntimeEventLedgerRejected,
  RuntimeEventLedgerService,
  RuntimeEventLedgerServiceOptions
} from "./runtime-event-ledger-service.ts";
export { makeLocalControllerService } from "./local-controller-service.ts";
export {
  readPeripheralDocumentPayload,
  readAppendProgressPayload,
  validateLocalControllerDecisionId,
  readSetStatusPayload,
  readTaskDocumentPayload,
  readTaskIdPayload
} from "./local-controller-payloads.ts";
export {
  evaluateDecisionReckonGate,
  evaluateCompletionGate,
  evaluateReviewGate,
  extractMarkdownSection,
  isCloseoutPlaceholderMarkdown,
  isReviewPlaceholderMarkdown,
  isTaskDocumentPlaceholderMarkdown,
  parseReviewMarkdown,
  validatePhaseRows
} from "./task-lifecycle-gates.ts";
export {
  makeTaskLifecycleOrchestrator,
  readTaskLifecyclePolicy
} from "./task-lifecycle-orchestrator.ts";
export type {
  CompletionGateInput,
  DecisionReckonGateInput,
  DecisionReckonGateResult,
  PhaseRow,
  ReviewFinding,
  ReviewGateInput,
  ReviewGateResult,
  TaskDocumentPlaceholderPolicy,
  TaskDocumentPlaceholderSectionFingerprint,
  VerifierBackedReviewContract
} from "./task-lifecycle-gates.ts";
export type {
  TaskLifecycleError,
  TaskLifecycleFailure,
  TaskLifecycleOrchestrator,
  TaskLifecycleOrchestratorOptions,
  TaskLifecyclePolicy,
  TaskLifecycleProgressWriteResult,
  TaskLifecycleResult,
  TaskLifecycleStatusWriteResult,
  TaskLifecycleTreeStatusResult,
  TaskLifecycleSuccess,
  TaskLifecycleWriter
} from "./task-lifecycle-orchestrator.ts";
