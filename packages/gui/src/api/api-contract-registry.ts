import {
  DAEMON_GUI_COMMAND_RECEIPT_SCHEMA,
  daemonGuiActionMethods,
  daemonGuiReadMethods,
  daemonGuiReadSchemas,
  daemonGuiStreamFacets,
  type DaemonGuiActionMethod,
  type DaemonGuiRpcReadMethod,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";

export type ApiRouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "WS" | "STREAM";
export type ApiRouteAuth = "local-session-token" | "ssh-tunnel-local-token" | "none";
export type ApiServiceName = "DaemonProjectionService";
export type ApiServiceMethod =
  | (typeof daemonGuiReadMethods)[number]["serviceMethod"]
  | (typeof daemonGuiActionMethods)[number]["serviceMethod"]
  | (typeof daemonGuiStreamFacets)[number]["serviceMethod"];
type DaemonGuiStreamMethod = (typeof daemonGuiStreamFacets)[number]["method"];

export interface ApiRouteContract {
  readonly id: string;
  readonly method: ApiRouteMethod;
  readonly path: string;
  readonly inputSchemaId: string;
  readonly outputSchemaId?: string;
  readonly errorSchemaId: string;
  readonly service: ApiServiceName;
  readonly serviceMethod: ApiServiceMethod;
  readonly requiresRepo: boolean;
  readonly auth: ApiRouteAuth;
  readonly rpcMethod?: DaemonGuiRpcReadMethod | DaemonGuiActionMethod | DaemonGuiStreamMethod;
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
/** Optional narrow/paged facets for the wide task reads; absent fields keep the full-result contract. */
export interface GuiTaskQueryPayload {
  readonly status?: string;
  readonly changedAfterRevision?: number;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface GuiAgendaQueryPayload {
  readonly limit?: number;
  readonly cursor?: string;
}
export interface GuiRelationQueryPayload {
  readonly status?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface GuiTaskDocumentPayload {
  readonly taskId: string;
  readonly path: string;
}
export interface GuiTaskDocumentListPayload {
  readonly taskId: string;
}

export const apiSchemaContracts = [
  { id: "gui.empty/v1", owner: "gui", typeName: "EmptyGuiPayload" },
  { id: "gui.task-query/v1", owner: "gui", typeName: "GuiTaskQueryPayload" },
  { id: "gui.agenda-query/v1", owner: "gui", typeName: "GuiAgendaQueryPayload" },
  { id: "gui.relation-query/v1", owner: "gui", typeName: "GuiRelationQueryPayload" },
  { id: "gui.task-document/v1", owner: "gui", typeName: "GuiTaskDocumentPayload" },
  { id: "gui.task-document-list/v1", owner: "gui", typeName: "GuiTaskDocumentListPayload" },
  { id: "gui.observe-tail/v3", owner: "gui", typeName: "ObserveTailPayload" },
  { id: "gui.agent-runtime-overview/v1", owner: "gui", typeName: "AgentRuntimeOverviewPayload" },
  { id: "gui.agent-runtime-session/v1", owner: "gui", typeName: "AgentRuntimeSessionPayload" },
  { id: "gui.agent-runtime-events/v1", owner: "gui", typeName: "AgentRuntimeEventsPayload" },
  ...daemonGuiActionMethods.map(({ inputSchemaId }) => ({
    id: inputSchemaId,
    owner: "gui" as const,
    typeName: inputSchemaId,
  })),
  ...daemonGuiReadSchemas.map(({ id }) => ({ id, owner: "daemon" as const, typeName: id })),
  { id: DAEMON_GUI_COMMAND_RECEIPT_SCHEMA.id, owner: "daemon", typeName: "DaemonGuiActionResult" },
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
  requiresRepo: contract.requiresRepo,
  auth: contract.auth,
  rpcMethod: contract.method,
  guiBridgeMethod: contract.guiBridgeMethod,
}));
const guiStreamApiRouteContracts = daemonGuiStreamFacets.map((contract) => ({
  id: contract.id,
  method: contract.httpMethod,
  path: contract.path,
  inputSchemaId: contract.inputSchemaId,
  outputSchemaId: contract.outputSchemaId,
  errorSchemaId: contract.errorSchemaId,
  service: "DaemonProjectionService" as const,
  serviceMethod: contract.serviceMethod,
  requiresRepo: contract.requiresRepo,
  auth: contract.auth,
  rpcMethod: contract.method,
  guiBridgeMethod: contract.guiBridgeMethod,
}));

export const apiRouteContracts = Object.freeze([
  ...guiApiRouteContracts,
  ...guiStreamApiRouteContracts,
]) as ReadonlyArray<ApiRouteContract>;
