import { taskWriteApiRoutePolicies, type LocalControllerService } from "../../../application/src/index.ts";
import type { TerminalSessionService } from "../terminal/session-registry.ts";

export type ApiRouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "WS";
export type ApiRouteAuth = "local-session-token" | "ssh-tunnel-local-token" | "none";
export type ApiServiceName = "LocalControllerService" | "TerminalSessionService";
export type ApiServiceMethod = keyof LocalControllerService | keyof TerminalSessionService;

export interface ApiRouteContract {
  readonly id: string;
  readonly method: ApiRouteMethod;
  readonly path: string;
  readonly inputSchemaId: string;
  readonly outputSchemaId?: string;
  readonly errorSchemaId: string;
  readonly service: ApiServiceName;
  readonly serviceMethod: ApiServiceMethod;
  readonly auth: ApiRouteAuth;
  readonly guiBridgeMethod?: string;
  readonly leaseRequired?: boolean;
  readonly commandClass?: "repo-read" | "repo-write" | "arbiter";
}

export interface ApiSchemaContract {
  readonly id: string;
  readonly owner: "application" | "gui";
  readonly typeName: string;
}

export interface DeferredGuiBridgeContract {
  readonly guiBridgeMethod: string;
  readonly service: "LocalControllerService";
  readonly serviceMethod: keyof LocalControllerService;
  readonly reason: string;
}

export interface TerminalGuiBridgeContract {
  readonly guiBridgeMethod: string;
  readonly routeId: string;
  readonly serviceMethod: keyof TerminalSessionService;
}

export interface EmptyGuiPayload {
  readonly kind?: "empty";
}

export const apiSchemaContracts = [
  { id: "gui.empty/v1", owner: "gui", typeName: "EmptyGuiPayload" },
  { id: "application.append-task-progress-payload/v1", owner: "application", typeName: "AppendTaskProgressPayload" },
  { id: "application.catalog-snapshot-result/v1", owner: "application", typeName: "CatalogSnapshotResult" },
  { id: "application.decision-detail-result/v1", owner: "application", typeName: "DecisionDetailResult" },
  { id: "application.decision-id-payload/v1", owner: "application", typeName: "DecisionIdPayload" },
  { id: "application.decision-list-result/v1", owner: "application", typeName: "DecisionListResult" },
  { id: "application.decision-mutation-result/v1", owner: "application", typeName: "DecisionMutationResult" },
  { id: "application.decision-propose-payload/v1", owner: "application", typeName: "DecisionProposePayload" },
  { id: "application.decision-transition-payload/v1", owner: "application", typeName: "DecisionTransitionPayload" },
  { id: "application.execution-detail-result/v1", owner: "application", typeName: "ExecutionDetailResult" },
  { id: "application.execution-evidence-page-payload/v1", owner: "application", typeName: "ExecutionEvidencePagePayload" },
  { id: "application.execution-evidence-page-result/v1", owner: "application", typeName: "ExecutionEvidencePageResult" },
  { id: "application.execution-id-payload/v1", owner: "application", typeName: "ExecutionIdPayload" },
  { id: "application.execution-list-result/v1", owner: "application", typeName: "ExecutionListResult" },
  { id: "application.fact-list-result/v1", owner: "application", typeName: "TaskFactListResult" },
  { id: "application.all-facts-list-result/v1", owner: "application", typeName: "FactListResult" },
  { id: "application.local-controller-error/v1", owner: "application", typeName: "LocalControllerError" },
  { id: "application.local-controller-result/v1", owner: "application", typeName: "LocalControllerResult" },
  { id: "application.peripheral-document-list-result/v1", owner: "application", typeName: "PeripheralDocumentListResult" },
  { id: "application.peripheral-document-payload/v1", owner: "application", typeName: "PeripheralDocumentPayload" },
  { id: "application.peripheral-document-result/v1", owner: "application", typeName: "PeripheralDocumentResult" },
  { id: "application.relation-graph-result/v1", owner: "application", typeName: "RelationGraphReadResult" },
  { id: "application.review-detail-result/v1", owner: "application", typeName: "ReviewDetailResult" },
  { id: "application.review-id-payload/v1", owner: "application", typeName: "ReviewIdPayload" },
  { id: "application.set-task-status-payload/v1", owner: "application", typeName: "SetTaskStatusPayload" },
  { id: "application.task-detail-result/v1", owner: "application", typeName: "TaskDetailResult" },
  { id: "application.task-document-payload/v1", owner: "application", typeName: "TaskDocumentPayload" },
  { id: "application.task-document-result/v1", owner: "application", typeName: "TaskDocumentResult" },
  { id: "application.task-id-payload/v1", owner: "application", typeName: "TaskIdPayload" },
  { id: "application.task-list-result/v1", owner: "application", typeName: "TaskListResult" },
  { id: "application.triadic-projection-result/v1", owner: "application", typeName: "TriadicProjectionResult" },
  { id: "application.task-execution-list-result/v1", owner: "application", typeName: "TaskExecutionListResult" },
  { id: "terminal.attach-policy-result/v1", owner: "gui", typeName: "TerminalAttachPolicyResult" },
  { id: "terminal.create-session-payload/v1", owner: "gui", typeName: "CreateTerminalSessionPayload" },
  { id: "terminal.output-read-payload/v1", owner: "gui", typeName: "ReadTerminalSessionPayload" },
  { id: "terminal.output-read-result/v1", owner: "gui", typeName: "TerminalOutputReadResult" },
  { id: "terminal.resize-session-payload/v1", owner: "gui", typeName: "ResizeTerminalSessionPayload" },
  { id: "terminal.session-detail-result/v1", owner: "gui", typeName: "TerminalSessionDetailResult" },
  { id: "terminal.session-error/v1", owner: "gui", typeName: "TerminalSessionFailure" },
  { id: "terminal.session-id-payload/v1", owner: "gui", typeName: "TerminalSessionIdPayload" },
  { id: "terminal.session-list-result/v1", owner: "gui", typeName: "TerminalSessionListResult" },
  { id: "terminal.write-session-payload/v1", owner: "gui", typeName: "WriteTerminalSessionPayload" }
] as const satisfies ReadonlyArray<ApiSchemaContract>;

export const apiRouteContracts = [
  {
    id: "catalog.snapshot",
    method: "GET",
    path: "/api/catalog",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.catalog-snapshot-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getCatalogSnapshot",
    auth: "local-session-token",
    guiBridgeMethod: "getCatalogSnapshot"
  },
  {
    id: "tasks.list",
    method: "GET",
    path: "/api/tasks",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.task-list-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getTasks",
    auth: "local-session-token",
    guiBridgeMethod: "getTasks"
  },
  {
    id: "tasks.detail",
    method: "GET",
    path: "/api/tasks/:taskId",
    inputSchemaId: "application.task-id-payload/v1",
    outputSchemaId: "application.task-detail-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getTaskDetail",
    auth: "local-session-token",
    guiBridgeMethod: "getTaskDetail"
  },
  {
    id: "tasks.document.read",
    method: "GET",
    path: "/api/tasks/:taskId/documents/:path",
    inputSchemaId: "application.task-document-payload/v1",
    outputSchemaId: "application.task-document-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getTaskDocument",
    auth: "local-session-token",
    guiBridgeMethod: "getTaskDocument"
  },
  {
    id: "documents.peripheral.list",
    method: "GET",
    path: "/api/documents",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.peripheral-document-list-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getPeripheralDocuments",
    auth: "local-session-token",
    guiBridgeMethod: "getPeripheralDocuments"
  },
  {
    id: "documents.peripheral.read",
    method: "GET",
    path: "/api/documents/:path",
    inputSchemaId: "application.peripheral-document-payload/v1",
    outputSchemaId: "application.peripheral-document-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getPeripheralDocument",
    auth: "local-session-token",
    guiBridgeMethod: "getPeripheralDocument"
  },
  ...taskWriteApiRoutePolicies,
  {
    id: "governance.rebuild",
    method: "POST",
    path: "/api/governance/rebuild",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.task-list-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "rebuildGovernance",
    auth: "local-session-token",
    guiBridgeMethod: "rebuildGovernance"
  },
  {
    id: "triadic.snapshot",
    method: "GET",
    path: "/api/triadic",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.triadic-projection-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getTriadicProjection",
    auth: "local-session-token",
    guiBridgeMethod: "getTriadicProjection"
  },
  {
    id: "triadic.relationGraph",
    method: "GET",
    path: "/api/triadic/relation-graph",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.relation-graph-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getRelationGraph",
    auth: "local-session-token",
    guiBridgeMethod: "getRelationGraph"
  },
  {
    id: "decisions.list",
    method: "GET",
    path: "/api/decisions",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.decision-list-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getDecisions",
    auth: "local-session-token",
    guiBridgeMethod: "getDecisions"
  },
  {
    id: "decisions.detail",
    method: "GET",
    path: "/api/decisions/:decisionId",
    inputSchemaId: "application.decision-id-payload/v1",
    outputSchemaId: "application.decision-detail-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getDecisionDetail",
    auth: "local-session-token",
    guiBridgeMethod: "getDecisionDetail"
  },
  {
    id: "facts.list",
    method: "GET",
    path: "/api/facts",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.all-facts-list-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getFacts",
    auth: "local-session-token",
    guiBridgeMethod: "getFacts"
  },
  {
    id: "facts.taskList",
    method: "GET",
    path: "/api/tasks/:taskId/facts",
    inputSchemaId: "application.task-id-payload/v1",
    outputSchemaId: "application.fact-list-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getTaskFacts",
    auth: "local-session-token",
    guiBridgeMethod: "getTaskFacts"
  },
  {
    id: "executions.list",
    method: "GET",
    path: "/api/executions",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "application.execution-list-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getExecutions",
    auth: "local-session-token",
    guiBridgeMethod: "getExecutions"
  },
  {
    id: "executions.evidencePage",
    method: "GET",
    path: "/api/executions/evidence",
    inputSchemaId: "application.execution-evidence-page-payload/v1",
    outputSchemaId: "application.execution-evidence-page-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getExecutionEvidencePage",
    auth: "local-session-token",
    guiBridgeMethod: "getExecutionEvidencePage"
  },
  {
    id: "executions.taskList",
    method: "GET",
    path: "/api/tasks/:taskId/executions",
    inputSchemaId: "application.task-id-payload/v1",
    outputSchemaId: "application.task-execution-list-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getTaskExecutions",
    auth: "local-session-token",
    guiBridgeMethod: "getTaskExecutions"
  },
  {
    id: "executions.detail",
    method: "GET",
    path: "/api/executions/:executionId",
    inputSchemaId: "application.execution-id-payload/v1",
    outputSchemaId: "application.execution-detail-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getExecutionDetail",
    auth: "local-session-token",
    guiBridgeMethod: "getExecutionDetail"
  },
  {
    id: "reviews.detail",
    method: "GET",
    path: "/api/reviews/:reviewId",
    inputSchemaId: "application.review-id-payload/v1",
    outputSchemaId: "application.review-detail-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "getReviewDetail",
    auth: "local-session-token",
    guiBridgeMethod: "getReviewDetail"
  },
  {
    id: "decisions.propose",
    method: "POST",
    path: "/api/decisions",
    inputSchemaId: "application.decision-propose-payload/v1",
    outputSchemaId: "application.decision-mutation-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "proposeDecision",
    auth: "local-session-token",
    guiBridgeMethod: "proposeDecision",
    commandClass: "repo-write"
  },
  {
    id: "decisions.accept",
    method: "POST",
    path: "/api/decisions/:decisionId/accept",
    inputSchemaId: "application.decision-transition-payload/v1",
    outputSchemaId: "application.decision-mutation-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "acceptDecision",
    auth: "local-session-token",
    guiBridgeMethod: "acceptDecision",
    commandClass: "arbiter"
  },
  {
    id: "decisions.reject",
    method: "POST",
    path: "/api/decisions/:decisionId/reject",
    inputSchemaId: "application.decision-transition-payload/v1",
    outputSchemaId: "application.decision-mutation-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "rejectDecision",
    auth: "local-session-token",
    guiBridgeMethod: "rejectDecision",
    commandClass: "arbiter"
  },
  {
    id: "decisions.defer",
    method: "POST",
    path: "/api/decisions/:decisionId/defer",
    inputSchemaId: "application.decision-transition-payload/v1",
    outputSchemaId: "application.decision-mutation-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "deferDecision",
    auth: "local-session-token",
    guiBridgeMethod: "deferDecision",
    commandClass: "arbiter"
  },
  {
    id: "terminal.sessions.create",
    method: "POST",
    path: "/api/terminal/sessions",
    inputSchemaId: "terminal.create-session-payload/v1",
    outputSchemaId: "terminal.session-detail-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "createSession",
    auth: "local-session-token",
    commandClass: "repo-read"
  },
  {
    id: "terminal.sessions.list",
    method: "GET",
    path: "/api/terminal/sessions",
    inputSchemaId: "gui.empty/v1",
    outputSchemaId: "terminal.session-list-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "listSessions",
    auth: "local-session-token"
  },
  {
    id: "terminal.sessions.get",
    method: "GET",
    path: "/api/terminal/sessions/:id",
    inputSchemaId: "terminal.session-id-payload/v1",
    outputSchemaId: "terminal.session-detail-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "getSession",
    auth: "local-session-token"
  },
  {
    id: "terminal.sessions.attach",
    method: "WS",
    path: "/api/terminal/sessions/:id/attach",
    inputSchemaId: "terminal.session-id-payload/v1",
    outputSchemaId: "terminal.attach-policy-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "attachSession",
    auth: "local-session-token"
  },
  {
    id: "terminal.sessions.write",
    method: "POST",
    path: "/api/terminal/sessions/:id/input",
    inputSchemaId: "terminal.write-session-payload/v1",
    outputSchemaId: "terminal.session-detail-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "writeSession",
    auth: "local-session-token",
    commandClass: "repo-read"
  },
  {
    id: "terminal.sessions.read",
    method: "GET",
    path: "/api/terminal/sessions/:id/output",
    inputSchemaId: "terminal.output-read-payload/v1",
    outputSchemaId: "terminal.output-read-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "readSession",
    auth: "local-session-token"
  },
  {
    id: "terminal.sessions.resize",
    method: "POST",
    path: "/api/terminal/sessions/:id/resize",
    inputSchemaId: "terminal.resize-session-payload/v1",
    outputSchemaId: "terminal.session-detail-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "resizeSession",
    auth: "local-session-token",
    commandClass: "repo-read"
  },
  {
    id: "terminal.sessions.close",
    method: "DELETE",
    path: "/api/terminal/sessions/:id",
    inputSchemaId: "terminal.session-id-payload/v1",
    outputSchemaId: "terminal.session-detail-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "closeSession",
    auth: "local-session-token",
    commandClass: "repo-read"
  }
] as const satisfies ReadonlyArray<ApiRouteContract>;

export const terminalGuiBridgeContracts = [
  { guiBridgeMethod: "terminalCreate", routeId: "terminal.sessions.create", serviceMethod: "createSession" },
  { guiBridgeMethod: "terminalWrite", routeId: "terminal.sessions.write", serviceMethod: "writeSession" },
  { guiBridgeMethod: "terminalRead", routeId: "terminal.sessions.read", serviceMethod: "readSession" },
  { guiBridgeMethod: "terminalResize", routeId: "terminal.sessions.resize", serviceMethod: "resizeSession" },
  { guiBridgeMethod: "terminalExit", routeId: "terminal.sessions.close", serviceMethod: "closeSession" }
] as const satisfies ReadonlyArray<TerminalGuiBridgeContract>;

export const deferredGuiBridgeContracts = [
  {
    guiBridgeMethod: "archiveTask",
    service: "LocalControllerService",
    serviceMethod: "archiveTask",
    reason: "Archive is exposed in the preload allowlist as a disabled placeholder until the closeout/archive route contract is implemented."
  },
  {
    guiBridgeMethod: "openShell",
    service: "LocalControllerService",
    serviceMethod: "openShell",
    reason: "Legacy shell button remains a display-only GUI policy placeholder; terminal sessions use explicit terminal route contracts."
  }
] as const satisfies ReadonlyArray<DeferredGuiBridgeContract>;
