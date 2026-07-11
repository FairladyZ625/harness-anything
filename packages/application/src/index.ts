import type { Effect } from "effect";
import type {
  ArtifactStore,
  DomainStatus,
  EngineError,
  ProjectionWarning,
  TaskProjectionRow,
  WriteError
} from "../../kernel/src/index.ts";
import type { HarnessLayoutOverrides } from "../../kernel/src/index.ts";
export { commandReceiptEnvelope } from "./command-receipt.ts";
export type { CommandFailureReceipt, CommandReceipt, CommandReceiptEnvelope } from "./command-receipt.ts";
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
  isCloseoutPlaceholderMarkdown,
  isReviewPlaceholderMarkdown,
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

export interface LocalControllerServiceOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly taskWriter: LocalControllerTaskWriter;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
}

export interface LocalControllerSuccess {
  readonly ok: true;
}

export interface LocalControllerError {
  readonly code: string;
  readonly hint: string;
}

export interface LocalControllerFailure {
  readonly ok: false;
  readonly error: LocalControllerError;
}

export type LocalControllerResult = LocalControllerSuccess | LocalControllerFailure;

export interface TaskListSuccess extends LocalControllerSuccess {
  readonly tasks: ReadonlyArray<TaskProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export type TaskListResult = TaskListSuccess | LocalControllerFailure;

export interface TaskDocumentDescriptor {
  readonly path: string;
}

export interface TaskDetailSuccess extends LocalControllerSuccess {
  readonly task?: TaskProjectionRow;
  readonly documents?: ReadonlyArray<TaskDocumentDescriptor>;
}

export type TaskDetailResult = TaskDetailSuccess | LocalControllerFailure;

export interface DecisionProjectionRejected {
  readonly text: string;
  readonly whyNot: string;
}

export interface DecisionProjectionActor {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}

export interface ProjectionProvenanceEntry {
  readonly runtime: string;
  readonly sessionId: string;
  readonly boundAt: string;
}

export interface DecisionProjectionRow {
  readonly schema: "d4-decision-row/v1";
  readonly decisionId: string;
  readonly legacyId?: string;
  readonly state: string;
  readonly title: string;
  readonly question: string;
  readonly chosen: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<DecisionProjectionRejected>;
  readonly path: string;
  readonly moduleKeys: ReadonlyArray<string>;
  readonly productLineKeys: ReadonlyArray<string>;
  readonly riskTier?: "low" | "medium" | "high";
  readonly urgency?: "low" | "medium" | "high";
  readonly vertical?: string;
  readonly preset?: string;
  readonly proposedBy?: DecisionProjectionActor;
  readonly proposedAt?: string;
  readonly arbiter?: DecisionProjectionActor;
  readonly provenance?: ReadonlyArray<ProjectionProvenanceEntry>;
  readonly decidedAt?: string;
}

export type FactConfidence = "low" | "medium" | "high";
export type FactMemoryClass = "semantic" | "episodic" | "procedural";
export type FactMemoryTag = "episode" | "procedural" | "tool_memory" | "pattern" | "task_skill" | "abstract_rule" | "other";

export interface TaskDocumentSuccess extends LocalControllerSuccess {
  readonly taskId?: string;
  readonly path?: string;
  readonly body?: string;
}

export type TaskDocumentResult = TaskDocumentSuccess | LocalControllerFailure;

export interface RelationGraphEdgeRow {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: string;
  readonly direction: string;
  readonly strength: string;
  readonly origin: string;
  readonly state: string;
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}

export interface RelationCoverageRow {
  readonly decisionRef: string;
  readonly claimRef: string;
  readonly status: "covered" | "uncovered";
  readonly coveringFactRef?: string;
  readonly relationPath: ReadonlyArray<string>;
}

export interface FactAnchorRow {
  readonly factRef: string;
  readonly taskId: string;
  readonly factId: string;
  readonly sourcePath: string;
}

export interface RelationGraphReadSuccess extends LocalControllerSuccess {
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export type RelationGraphReadResult = RelationGraphReadSuccess | LocalControllerFailure;

export interface DecisionListSuccess extends LocalControllerSuccess {
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export type DecisionListResult = DecisionListSuccess | LocalControllerFailure;

export interface DecisionDetailSuccess extends LocalControllerSuccess {
  readonly decision: DecisionProjectionRow;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export type DecisionDetailResult = DecisionDetailSuccess | LocalControllerFailure;

export interface DecisionIdPayload {
  readonly decisionId: string;
}

export interface FactProjectionRow {
  readonly schema: "task-fact-row/v1";
  readonly ref: string;
  readonly taskId: string;
  readonly factId: string;
  readonly statement: string;
  readonly source: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly memoryClass: FactMemoryClass;
  readonly memoryTags: ReadonlyArray<FactMemoryTag>;
  readonly provenance: ReadonlyArray<ProjectionProvenanceEntry>;
}

export interface TaskFactListSuccess extends LocalControllerSuccess {
  readonly taskId: string;
  readonly path: string;
  readonly facts: ReadonlyArray<FactProjectionRow>;
}

export type TaskFactListResult = TaskFactListSuccess | LocalControllerFailure;

export interface TaskIdPayload {
  readonly taskId: string;
}

export interface TaskDocumentPayload extends TaskIdPayload {
  readonly path: string;
}

export interface SetTaskStatusPayload extends TaskIdPayload {
  readonly status: DomainStatus;
}

export interface AppendTaskProgressPayload extends TaskIdPayload {
  readonly text: string;
}

export interface LocalControllerStatusWriteResult {
  readonly taskId: string;
  readonly status: DomainStatus;
}

export interface LocalControllerProgressWriteResult {
  readonly taskId: string;
  readonly path: string;
}

export interface LocalControllerTaskTreeStatusResult {
  readonly taskId: string;
  readonly dirty: boolean;
  readonly entries: ReadonlyArray<string>;
}

export interface LocalControllerTaskWriter {
  readonly setStatus: (payload: SetTaskStatusPayload) => Effect.Effect<LocalControllerStatusWriteResult, EngineError | WriteError>;
  readonly appendProgress: (payload: AppendTaskProgressPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteError>;
  readonly stageDocument: (payload: TaskDocumentPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteError>;
  readonly stageTaskTree: (payload: TaskIdPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteError>;
  readonly taskTreeStatus: (payload: TaskIdPayload) => Effect.Effect<LocalControllerTaskTreeStatusResult, EngineError | WriteError>;
}

export interface ShellPanelPolicy {
  readonly displayOnly: true;
  readonly outputCreatesTaskState: false;
}

export interface OpenShellSuccess extends LocalControllerSuccess {
  readonly policy: ShellPanelPolicy;
}

export type OpenShellResult = OpenShellSuccess | LocalControllerFailure;

export interface LocalControllerService {
  readonly getTasks: () => TaskListResult;
  readonly getTaskDetail: (payload: TaskIdPayload) => Promise<TaskDetailResult>;
  readonly getTaskDocument: (payload: TaskDocumentPayload) => Promise<TaskDocumentResult>;
  readonly getRelationGraph: () => RelationGraphReadResult;
  readonly getDecisions: () => DecisionListResult;
  readonly getDecisionDetail: (payload: DecisionIdPayload) => DecisionDetailResult;
  readonly getTaskFacts: (payload: TaskIdPayload) => Promise<TaskFactListResult>;
  readonly setTaskStatus: (payload: SetTaskStatusPayload) => Promise<LocalControllerResult>;
  readonly reviewTask: (payload: TaskIdPayload) => Promise<LocalControllerResult>;
  readonly appendTaskProgress: (payload: AppendTaskProgressPayload) => Promise<LocalControllerResult>;
  readonly rebuildGovernance: () => TaskListResult;
  readonly archiveTask: () => LocalControllerResult;
  readonly openShell: () => OpenShellResult;
}

// check-implementation-contracts scans this entrypoint; document path normalization is delegated to local-controller-payloads.ts via normalizeRelativeDocumentPath.
