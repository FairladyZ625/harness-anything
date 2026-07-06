import { apiRouteContracts, type ApiRouteContract } from "../../../gui/src/api/api-contract-registry.ts";

export const currentDaemonProtocolVersion = 1 as const;

export type JsonRpcMethodMode = "active" | "notification-stub" | "reserved";

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

const notificationStubContracts = [
  {
    method: "repo.notifications.subscribe",
    mode: "notification-stub",
    namespace: "repo",
    inputSchemaId: "daemon.notification-subscription/v1",
    outputSchemaId: "daemon.notification-subscription-result/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true
  },
  {
    method: "repo.notifications.unsubscribe",
    mode: "notification-stub",
    namespace: "repo",
    inputSchemaId: "daemon.notification-subscription/v1",
    outputSchemaId: "daemon.notification-subscription-result/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true
  }
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;

const adminReservedContracts = [
  {
    method: "admin.people.list",
    mode: "reserved",
    namespace: "admin",
    inputSchemaId: "daemon.admin-empty/v1",
    outputSchemaId: "daemon.admin-people-list/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: false
  },
  {
    method: "admin.rbac.roles.list",
    mode: "reserved",
    namespace: "admin",
    inputSchemaId: "daemon.admin-empty/v1",
    outputSchemaId: "daemon.admin-rbac-roles-list/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: false
  }
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;

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
    requiresRepo: true
  }));
}

export const jsonRpcServiceMethodContracts = deriveJsonRpcServiceMethodContracts();

export const jsonRpcMethodContracts = [
  ...protocolMethodContracts,
  ...jsonRpcServiceMethodContracts,
  ...notificationStubContracts,
  ...adminReservedContracts
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;
