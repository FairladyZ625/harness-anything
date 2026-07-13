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
export * from "./public-exports.ts";

export interface LocalControllerServiceOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly taskWriter: LocalControllerTaskWriter;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage" | "listAuthoredDocuments" | "readAuthoredDocument">;
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

/** 服务面自己的文档种类,不直接摆 kernel 的 ArtifactDocumentKind —— controller 的
 *  DTO 面不许泄漏 kernel 类型(check-service-mappability)。两者是同一组字面量,
 *  kernel 的值可直接赋进来;真要分叉时,分叉点会显形在这里而不是悄悄穿透。 */
export type TaskDocumentKind = "document" | "attachment";

export interface TaskDocumentDescriptor {
  readonly path: string;
  readonly kind: TaskDocumentKind;
}

export interface TaskDetailSuccess extends LocalControllerSuccess {
  readonly task?: TaskProjectionRow;
  readonly documents?: ReadonlyArray<TaskDocumentDescriptor>;
}

export type TaskDetailResult = TaskDetailSuccess | LocalControllerFailure;

export interface PeripheralDocumentListSuccess extends LocalControllerSuccess {
  readonly documents: ReadonlyArray<PeripheralDocumentDescriptor>;
}

export type PeripheralDocumentListResult = PeripheralDocumentListSuccess | LocalControllerFailure;

export interface PeripheralDocumentDescriptor {
  readonly path: string;
}

export interface PeripheralDocumentPayload {
  readonly path: string;
}

export interface PeripheralDocumentSuccess extends LocalControllerSuccess {
  readonly path: string;
  readonly body: string;
}

export type PeripheralDocumentResult = PeripheralDocumentSuccess | LocalControllerFailure;

export interface DecisionProjectionRejected {
  readonly text: string;
  readonly whyNot: string;
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
  readonly proposedAt?: string;
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

export interface ExecutionIdPayload {
  readonly executionId: string;
}

export interface ProjectionJsonObject { readonly [key: string]: ProjectionJsonValue }
export type ProjectionJsonValue = string | number | boolean | null | ReadonlyArray<ProjectionJsonValue> | ProjectionJsonObject;

export interface ExecutionProjectionRow {
  readonly executionId: string;
  readonly taskRef: string;
  readonly taskId: string;
  readonly state: string;
  readonly executor: ProjectionJsonValue;
  readonly primaryActor: ProjectionJsonValue;
  readonly claimedAt: string;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly sessionBindings: ReadonlyArray<ProjectionJsonObject>;
  readonly outputs: ReadonlyArray<ProjectionJsonValue>;
  readonly submission: ProjectionJsonValue;
}

export interface ReviewProjectionRow {
  readonly reviewId: string;
  readonly taskRef: string;
  readonly taskId: string;
  readonly executionRef: string;
  readonly executionId: string;
  readonly verdict: string;
  readonly reviewerActor: ProjectionJsonValue;
  readonly reviewerSessionRef: string;
  readonly findings: string;
  readonly archiveWarningsAcknowledged: boolean;
  readonly reviewedAt: string;
}

export interface ReviewIdPayload {
  readonly reviewId: string;
}

export interface TaskExecutionListSuccess extends LocalControllerSuccess {
  readonly taskId: string;
  readonly executions: ReadonlyArray<ExecutionProjectionRow>;
}

export type TaskExecutionListResult = TaskExecutionListSuccess | LocalControllerFailure;

export interface ExecutionListSuccess extends LocalControllerSuccess {
  readonly executions: ReadonlyArray<ExecutionProjectionRow>;
}

export type ExecutionListResult = ExecutionListSuccess | LocalControllerFailure;

export interface ExecutionDetailSuccess extends LocalControllerSuccess {
  readonly execution: ExecutionProjectionRow;
}

export type ExecutionDetailResult = ExecutionDetailSuccess | LocalControllerFailure;

export interface ReviewDetailSuccess extends LocalControllerSuccess {
  readonly review: ReviewProjectionRow;
}

export type ReviewDetailResult = ReviewDetailSuccess | LocalControllerFailure;

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

export interface FactListSuccess extends LocalControllerSuccess {
  readonly facts: ReadonlyArray<FactProjectionRow>;
}

export type FactListResult = FactListSuccess | LocalControllerFailure;

export interface TriadicProjectionSuccess extends LocalControllerSuccess {
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly facts: ReadonlyArray<FactProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export type TriadicProjectionResult = TriadicProjectionSuccess | LocalControllerFailure;

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
  readonly getPeripheralDocuments: () => Promise<PeripheralDocumentListResult>;
  readonly getPeripheralDocument: (payload: PeripheralDocumentPayload) => Promise<PeripheralDocumentResult>;
  readonly getRelationGraph: () => RelationGraphReadResult;
  readonly getDecisions: () => DecisionListResult;
  readonly getDecisionDetail: (payload: DecisionIdPayload) => DecisionDetailResult;
  readonly getTaskExecutions: (payload: TaskIdPayload) => TaskExecutionListResult;
  readonly getExecutions: () => ExecutionListResult;
  readonly getExecutionDetail: (payload: ExecutionIdPayload) => ExecutionDetailResult;
  readonly getReviewDetail: (payload: ReviewIdPayload) => ReviewDetailResult;
  readonly getTaskFacts: (payload: TaskIdPayload) => Promise<TaskFactListResult>;
  readonly getFacts: () => Promise<FactListResult>;
  readonly getTriadicProjection: () => Promise<TriadicProjectionResult>;
  readonly setTaskStatus: (payload: SetTaskStatusPayload) => Promise<LocalControllerResult>;
  readonly reviewTask: (payload: TaskIdPayload) => Promise<LocalControllerResult>;
  readonly appendTaskProgress: (payload: AppendTaskProgressPayload) => Promise<LocalControllerResult>;
  readonly rebuildGovernance: () => TaskListResult;
  readonly archiveTask: () => LocalControllerResult;
  readonly openShell: () => OpenShellResult;
}

// check-implementation-contracts scans this entrypoint; document path normalization is delegated to local-controller-payloads.ts via normalizeRelativeDocumentPath.
