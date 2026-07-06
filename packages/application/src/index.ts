import type { Effect } from "effect";
import type { DomainStatus, EngineError, ProjectionWarning, TaskProjectionRow, WriteError } from "../../kernel/src/index.ts";
import type { HarnessLayoutOverrides } from "../../kernel/src/index.ts";
export { currentSessionToProvenancePayload, defaultRuntimeSessionEnvCandidates, makeEnvironmentCurrentSessionProbe, makeHumanFallbackSessionProbe } from "./current-session-probe.ts";
export { bindCreateProvenance } from "./provenance-binding.ts";
export { makeDecisionWriteService } from "./decision-write-service.ts";
export { makeFactWriteService } from "./fact-write-service.ts";
export { makeProvenanceSessionExporter } from "./provenance-session-exporter.ts";
export { makeRuntimeEventLedgerService } from "./runtime-event-ledger-service.ts";
export { listDecisionDocuments, readDecisionDocument } from "./decision-document-reader.ts";
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
  ProvenanceSessionBackfillOptions,
  ProvenanceSessionBackfillResult,
  ProvenanceSessionDocument,
  ProvenanceSessionExporter,
  ProvenanceSessionExporterOptions,
  ProvenanceSessionExporterRejected,
  ProvenanceSessionExportResult
} from "./provenance-session-exporter.ts";
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

export interface TaskDocumentSuccess extends LocalControllerSuccess {
  readonly taskId?: string;
  readonly path?: string;
  readonly body?: string;
}

export type TaskDocumentResult = TaskDocumentSuccess | LocalControllerFailure;

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
  readonly getTaskDetail: (payload: TaskIdPayload) => TaskDetailResult;
  readonly getTaskDocument: (payload: TaskDocumentPayload) => TaskDocumentResult;
  readonly setTaskStatus: (payload: SetTaskStatusPayload) => Promise<LocalControllerResult>;
  readonly reviewTask: (payload: TaskIdPayload) => Promise<LocalControllerResult>;
  readonly appendTaskProgress: (payload: AppendTaskProgressPayload) => Promise<LocalControllerResult>;
  readonly rebuildGovernance: () => TaskListResult;
  readonly archiveTask: () => LocalControllerResult;
  readonly openShell: () => OpenShellResult;
}

// check-implementation-contracts scans this entrypoint; document path normalization is delegated to local-controller-payloads.ts via normalizeRelativeDocumentPath.
