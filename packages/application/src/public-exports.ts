// application 包的 re-export barrel。
// 它从 index.ts 分出来的唯一原因是 check-api-contract-registry 只解析 index.ts 的
// 文本声明(不跟随 re-export),所以 84 个契约类型必须留在 index.ts;而 check-file-complexity
// 卡 600 行。两道门夹住同一个文件 —— 搬走 barrel 是唯一不动门禁的出路。

export { commandReceiptEnvelope } from "./command-receipt.ts";
export {
  authorityProtocolTuple,
  canonicalAuthorityRequestDigest,
  createAuthoritySubmissionService,
  createInMemoryShadowPublicationLog,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  reconcileShadowPublications,
  shadowPublicationSchema,
  shadowReconciliationSchema
} from "./authority/index.ts";
export type {
  AttributedCoordinatorFactory,
  AuthorityCommittedReceipt,
  AuthorityFenceWitness,
  AuthorityIndeterminateReceipt,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityOperationRecord,
  AuthorityOperationRegistry,
  AuthorityOperationState,
  AuthorityProtocolTuple,
  AuthorityRejectedReceipt,
  AuthorityRetryableReceipt,
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
export type { CommandFailureReceipt, CommandReceipt, CommandReceiptEnvelope } from "./command-receipt.ts";
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
