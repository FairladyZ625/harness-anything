import { DAEMON_GUI_COMMAND_RECEIPT_SCHEMA, daemonGuiActionMethods, daemonGuiReadMethods, daemonGuiReadSchemas, daemonGuiStreamFacets, type DaemonGuiActionMethod, type DaemonGuiReadMethod, type DaemonGuiStreamMethod } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { TerminalSessionService } from "../terminal/session-registry.ts";

export type ApiRouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "WS" | "STREAM";
export type ApiRouteAuth = "local-session-token" | "ssh-tunnel-local-token" | "none";
export type ApiServiceName = "DaemonProjectionService" | "TerminalSessionService";
export type ApiServiceMethod = (typeof daemonGuiReadMethods)[number]["serviceMethod"] | (typeof daemonGuiActionMethods)[number]["serviceMethod"] | (typeof daemonGuiStreamFacets)[number]["serviceMethod"] | keyof TerminalSessionService;

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
  readonly rpcMethod?: DaemonGuiReadMethod | DaemonGuiActionMethod | DaemonGuiStreamMethod;
  readonly guiBridgeMethod?: string;
}

export interface ApiSchemaContract {
  readonly id: string;
  readonly owner: "daemon" | "gui";
  readonly typeName: string;
}

export interface EmptyGuiPayload {
  readonly kind?: "empty";
}
export interface GuiTaskDocumentPayload {
  readonly taskId: string; readonly path: string }

export const apiSchemaContracts = [
  { id: "gui.empty/v1", owner: "gui", typeName: "EmptyGuiPayload" },
  { id: "gui.task-document/v1", owner: "gui", typeName: "GuiTaskDocumentPayload" },
  { id: "gui.agent-runtime-overview/v1", owner: "gui", typeName: "AgentRuntimeOverviewPayload" }, { id: "gui.agent-runtime-session/v1", owner: "gui", typeName: "AgentRuntimeSessionPayload" }, { id: "gui.agent-runtime-events/v1", owner: "gui", typeName: "AgentRuntimeEventsPayload" }, { id: "gui.agent-runtime-attach/v1", owner: "gui", typeName: "AgentRuntimeAttachPayload" },
  ...daemonGuiActionMethods.map(({ inputSchemaId }) => ({ id: inputSchemaId, owner: "gui" as const, typeName: inputSchemaId })),
  ...daemonGuiReadSchemas.map(({ id }) => ({ id, owner: "daemon" as const, typeName: id })),
  { id: DAEMON_GUI_COMMAND_RECEIPT_SCHEMA.id, owner: "daemon", typeName: "DaemonGuiActionResult" },
  { id: "terminal.attach-policy-result/v1", owner: "gui", typeName: "TerminalAttachPolicyResult" },
  { id: "terminal.create-session-payload/v1", owner: "gui", typeName: "CreateTerminalSessionPayload" },
  { id: "terminal.resize-session-payload/v1", owner: "gui", typeName: "ResizeTerminalSessionPayload" },
  { id: "terminal.session-detail-result/v1", owner: "gui", typeName: "TerminalSessionDetailResult" },
  { id: "terminal.session-error/v1", owner: "gui", typeName: "TerminalSessionFailure" },
  { id: "terminal.session-id-payload/v1", owner: "gui", typeName: "TerminalSessionIdPayload" },
  { id: "terminal.session-list-result/v1", owner: "gui", typeName: "TerminalSessionListResult" }
] as const satisfies ReadonlyArray<ApiSchemaContract>;

const guiApiRouteContracts = [...daemonGuiReadMethods, ...daemonGuiActionMethods].map((contract) => ({
  id: contract.id,
  method: contract.httpMethod,
  path: contract.path,
  inputSchemaId: contract.inputSchemaId,
  outputSchemaId: contract.outputSchemaId,
  errorSchemaId: contract.errorSchemaId,
  service: "DaemonProjectionService" as const,
  serviceMethod: contract.serviceMethod,
  auth: contract.auth,
  rpcMethod: contract.method,
  guiBridgeMethod: contract.guiBridgeMethod
}));
const guiStreamApiRouteContracts = daemonGuiStreamFacets.map((contract) => ({ id: contract.id, method: contract.httpMethod, path: contract.path, inputSchemaId: contract.inputSchemaId, outputSchemaId: contract.outputSchemaId, errorSchemaId: contract.errorSchemaId, service: "DaemonProjectionService" as const, serviceMethod: contract.serviceMethod, auth: contract.auth, rpcMethod: contract.method, guiBridgeMethod: contract.guiBridgeMethod }));

const terminalApiRouteContracts = [
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

export const apiRouteContracts = Object.freeze([
  ...guiApiRouteContracts,
  ...guiStreamApiRouteContracts,
  ...terminalApiRouteContracts
]) as ReadonlyArray<ApiRouteContract>;
