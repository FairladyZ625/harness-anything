import type { LocalControllerService } from "../../../application/src/index.ts";
import type { PreloadApiMethod } from "../preload/allowlist.ts";
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
  readonly guiBridgeMethod?: PreloadApiMethod;
}

export interface ApiSchemaContract {
  readonly id: string;
  readonly owner: "application" | "gui";
  readonly typeName: string;
}

export interface DeferredGuiBridgeContract {
  readonly guiBridgeMethod: PreloadApiMethod;
  readonly service: "LocalControllerService";
  readonly serviceMethod: keyof LocalControllerService;
  readonly reason: string;
}

export interface EmptyGuiPayload {
  readonly kind?: "empty";
}

export const apiSchemaContracts = [
  { id: "gui.empty/v1", owner: "gui", typeName: "EmptyGuiPayload" },
  { id: "application.append-task-progress-payload/v1", owner: "application", typeName: "AppendTaskProgressPayload" },
  { id: "application.local-controller-error/v1", owner: "application", typeName: "LocalControllerError" },
  { id: "application.local-controller-result/v1", owner: "application", typeName: "LocalControllerResult" },
  { id: "application.set-task-status-payload/v1", owner: "application", typeName: "SetTaskStatusPayload" },
  { id: "application.task-detail-result/v1", owner: "application", typeName: "TaskDetailResult" },
  { id: "application.task-document-payload/v1", owner: "application", typeName: "TaskDocumentPayload" },
  { id: "application.task-document-result/v1", owner: "application", typeName: "TaskDocumentResult" },
  { id: "application.task-id-payload/v1", owner: "application", typeName: "TaskIdPayload" },
  { id: "application.task-list-result/v1", owner: "application", typeName: "TaskListResult" },
  { id: "terminal.attach-policy-result/v1", owner: "gui", typeName: "TerminalAttachPolicyResult" },
  { id: "terminal.create-session-payload/v1", owner: "gui", typeName: "CreateTerminalSessionPayload" },
  { id: "terminal.resize-session-payload/v1", owner: "gui", typeName: "ResizeTerminalSessionPayload" },
  { id: "terminal.session-detail-result/v1", owner: "gui", typeName: "TerminalSessionDetailResult" },
  { id: "terminal.session-error/v1", owner: "gui", typeName: "TerminalSessionFailure" },
  { id: "terminal.session-id-payload/v1", owner: "gui", typeName: "TerminalSessionIdPayload" },
  { id: "terminal.session-list-result/v1", owner: "gui", typeName: "TerminalSessionListResult" }
] as const satisfies ReadonlyArray<ApiSchemaContract>;

export const apiRouteContracts = [
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
    id: "tasks.status.set",
    method: "POST",
    path: "/api/tasks/:taskId/status",
    inputSchemaId: "application.set-task-status-payload/v1",
    outputSchemaId: "application.local-controller-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "setTaskStatus",
    auth: "local-session-token",
    guiBridgeMethod: "setTaskStatus"
  },
  {
    id: "tasks.review",
    method: "POST",
    path: "/api/tasks/:taskId/review",
    inputSchemaId: "application.task-id-payload/v1",
    outputSchemaId: "application.local-controller-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "reviewTask",
    auth: "local-session-token",
    guiBridgeMethod: "reviewTask"
  },
  {
    id: "tasks.progress.append",
    method: "POST",
    path: "/api/tasks/:taskId/progress",
    inputSchemaId: "application.append-task-progress-payload/v1",
    outputSchemaId: "application.local-controller-result/v1",
    errorSchemaId: "application.local-controller-error/v1",
    service: "LocalControllerService",
    serviceMethod: "appendTaskProgress",
    auth: "local-session-token",
    guiBridgeMethod: "appendTaskProgress"
  },
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
    id: "terminal.sessions.create",
    method: "POST",
    path: "/api/terminal/sessions",
    inputSchemaId: "terminal.create-session-payload/v1",
    outputSchemaId: "terminal.session-detail-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "createSession",
    auth: "local-session-token"
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
    id: "terminal.sessions.resize",
    method: "POST",
    path: "/api/terminal/sessions/:id/resize",
    inputSchemaId: "terminal.resize-session-payload/v1",
    outputSchemaId: "terminal.session-detail-result/v1",
    errorSchemaId: "terminal.session-error/v1",
    service: "TerminalSessionService",
    serviceMethod: "resizeSession",
    auth: "local-session-token"
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
    auth: "local-session-token"
  }
] as const satisfies ReadonlyArray<ApiRouteContract>;

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
