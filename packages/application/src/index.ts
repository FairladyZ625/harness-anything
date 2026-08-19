import type {
  ArtifactStore,
  ProjectionWarning,
  TaskProjectionRow
} from "../../kernel/src/index.ts";
import type { HarnessLayoutOverrides } from "../../kernel/src/index.ts";
export { commandReceiptEnvelope } from "./command-receipt.ts";
export type { CommandFailureReceipt, CommandReceipt, CommandReceiptEnvelope } from "./command-receipt.ts";
export { makeTaskLifecycleService, TaskLifecycleOperationConflict } from "./task-lifecycle-service.ts";
export type {
  TaskLifecycleKillpoint,
  TaskCarriedDocuments,
  TaskLeaseRenewInput,
  TaskLifecycleServiceProof,
  TaskLifecycleService,
  TaskLifecycleServiceRead
} from "./task-lifecycle-service.ts";
export { FactServiceError, makeDecisionService, makeFactService } from "./fact-service.ts";
export type { FactRecordResult, FactWriteBundle } from "./fact-service.ts";
export interface LocalControllerServiceOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
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

export interface ExecutionDetailSuccess extends LocalControllerSuccess {
  readonly execution: ExecutionProjectionRow;
}

export type ExecutionDetailResult = ExecutionDetailSuccess | LocalControllerFailure;

export interface ReviewDetailSuccess extends LocalControllerSuccess {
  readonly review: ReviewProjectionRow;
}

export type ReviewDetailResult = ReviewDetailSuccess | LocalControllerFailure;

export interface TaskIdPayload {
  readonly taskId: string;
}

export interface TaskDocumentPayload extends TaskIdPayload {
  readonly path: string;
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
  readonly getTaskExecutions: (payload: TaskIdPayload) => TaskExecutionListResult;
  readonly getExecutionDetail: (payload: ExecutionIdPayload) => ExecutionDetailResult;
  readonly getReviewDetail: (payload: ReviewIdPayload) => ReviewDetailResult;
  readonly rebuildGovernance: () => TaskListResult;
  readonly archiveTask: () => LocalControllerResult;
  readonly openShell: () => OpenShellResult;
}
