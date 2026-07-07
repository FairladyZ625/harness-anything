import { apiRouteContracts, type ApiRouteContract } from "../../../gui/src/api/api-contract-registry.ts";
import type { DaemonCommandClass } from "../identity/types.ts";

export const currentDaemonProtocolVersion = 1 as const;

export type JsonRpcMethodMode = "active" | "notification-stub" | "reserved";
export type { DaemonCommandClass };

export interface JsonRpcMethodContract {
  readonly method: string;
  readonly mode: JsonRpcMethodMode;
  readonly namespace: "protocol" | "repo" | "admin";
  readonly inputSchemaId: string;
  readonly outputSchemaId?: string;
  readonly errorSchemaId: string;
  readonly service?: ApiRouteContract["service"];
  readonly serviceMethod?: ApiRouteContract["serviceMethod"];
  readonly routeId?: ApiRouteContract["id"];
  readonly auth: ApiRouteContract["auth"];
  readonly requiresRepo: boolean;
  readonly commandClass?: DaemonCommandClass;
}

const protocolMethodContracts = [
  {
    method: "protocol.hello",
    mode: "active",
    namespace: "protocol",
    inputSchemaId: "daemon.hello-request/v1",
    outputSchemaId: "daemon.hello-result/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "none",
    requiresRepo: false
  }
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;

const cliCommandContracts = [
  {
    method: "repo.command.run",
    mode: "active",
    namespace: "repo",
    inputSchemaId: "daemon.cli-command-run/v1",
    outputSchemaId: "application.command-receipt/v2",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true,
    commandClass: "arbiter"
  }
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;

const notificationStubContracts = [
  {
    method: "repo.notifications.subscribe",
    mode: "notification-stub",
    namespace: "repo",
    inputSchemaId: "daemon.notification-subscription/v1",
    outputSchemaId: "daemon.notification-subscription-result/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true,
    commandClass: "repo-read"
  },
  {
    method: "repo.notifications.unsubscribe",
    mode: "notification-stub",
    namespace: "repo",
    inputSchemaId: "daemon.notification-subscription/v1",
    outputSchemaId: "daemon.notification-subscription-result/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true,
    commandClass: "repo-read"
  }
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;

const adminReservedContracts = [
  {
    method: "admin.people.list",
    mode: "active",
    namespace: "admin",
    inputSchemaId: "daemon.admin-empty/v1",
    outputSchemaId: "daemon.admin-people-list/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: false,
    commandClass: "admin"
  },
  {
    method: "admin.rbac.roles.list",
    mode: "active",
    namespace: "admin",
    inputSchemaId: "daemon.admin-empty/v1",
    outputSchemaId: "daemon.admin-rbac-roles-list/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: false,
    commandClass: "admin"
  }
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;

const arbiterApiRouteIds = new Set<string>(["tasks.status.set", "tasks.review"]);

export function deriveJsonRpcServiceMethodContracts(
  contracts: ReadonlyArray<ApiRouteContract> = apiRouteContracts
): ReadonlyArray<JsonRpcMethodContract> {
  return contracts.map((contract) => ({
    method: `repo.${contract.id}`,
    mode: "active",
    namespace: "repo",
    inputSchemaId: contract.inputSchemaId,
    ...(contract.outputSchemaId ? { outputSchemaId: contract.outputSchemaId } : {}),
    errorSchemaId: contract.errorSchemaId,
    service: contract.service,
    serviceMethod: contract.serviceMethod,
    routeId: contract.id,
    auth: contract.auth,
    requiresRepo: true,
    commandClass: commandClassForApiRoute(contract)
  }));
}

export function commandClassForApiRoute(contract: ApiRouteContract): DaemonCommandClass {
  if (arbiterApiRouteIds.has(contract.id)) return "arbiter";
  if (contract.method === "GET" || contract.method === "WS") return "repo-read";
  return "repo-write";
}

export const jsonRpcServiceMethodContracts = deriveJsonRpcServiceMethodContracts();

export const jsonRpcMethodContracts = [
  ...protocolMethodContracts,
  ...cliCommandContracts,
  ...jsonRpcServiceMethodContracts,
  ...notificationStubContracts,
  ...adminReservedContracts
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;
