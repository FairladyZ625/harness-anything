import type {
  ArtifactStore,
  ProjectionWarning,
  TaskProjectionRow
} from "../../kernel/src/index.ts";
import type { HarnessLayoutOverrides } from "../../kernel/src/index.ts";
export { commandReceiptEnvelope } from "./command-receipt.ts";
export type { CommandFailureReceipt, CommandReceipt, CommandReceiptEnvelope } from "./command-receipt.ts";
export { makeTaskLifecycleService, runTaskLifecycleEffect, TaskLifecycleOperationConflict } from "./task-lifecycle-service.ts";
export type {
  TaskLifecycleKillpoint,
  TaskLeaseRenewInput,
  TaskLifecycleServiceProof,
  TaskLifecycleService,
  TaskLifecycleServiceRead
} from "./task-lifecycle-service.ts";
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
  readonly getTaskExecutions: (payload: TaskIdPayload) => TaskExecutionListResult;
  readonly getExecutionDetail: (payload: ExecutionIdPayload) => ExecutionDetailResult;
  readonly getReviewDetail: (payload: ReviewIdPayload) => ReviewDetailResult;
  readonly getTaskFacts: (payload: TaskIdPayload) => Promise<TaskFactListResult>;
  readonly rebuildGovernance: () => TaskListResult;
  readonly archiveTask: () => LocalControllerResult;
  readonly openShell: () => OpenShellResult;
}
