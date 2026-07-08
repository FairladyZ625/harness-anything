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
  readonly commandClassDerivation?: "repo-command-run-action";
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
    commandClassDerivation: "repo-command-run-action"
  }
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;

const daemonStatusContracts = [
  {
    method: "repo.daemon.status",
    mode: "active",
    namespace: "repo",
    inputSchemaId: "daemon.status-request/v1",
    outputSchemaId: "daemon.status-result/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true,
    commandClass: "repo-read"
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

const repoReadCliActionKinds = new Set<string>([
  "capabilities",
  "check",
  "decision-list",
  "decision-show",
  "diagnostics-command-usage",
  "doc-list",
  "doc-map",
  "doctor",
  "entity-list",
  "fact-list",
  "fact-show",
  "help",
  "legacy-scan",
  "legacy-verify",
  "migrate-plan",
  "migrate-verify",
  "module-inspect",
  "module-list",
  "preset-audit",
  "preset-check",
  "preset-inspect",
  "preset-list",
  "preset-validate",
  "relation-list",
  "runtime-event-list",
  "script-inspect",
  "script-list",
  "snapshot-multica",
  "status",
  "task-list",
  "task-show",
  "task-tree",
  "template-list",
  "template-render",
  "vertical-validate",
  "version",
  "worktree-status"
]);

const repoWriteCliActionKinds = new Set<string>([
  "adopt-multica",
  "decision-amend",
  "decision-propose",
  "decision-reckon",
  "decision-relate",
  "decision-relation-replace",
  "decision-relation-retire",
  "distill-candidate",
  "distill-commit",
  "doc-generate",
  "fact-invalidate",
  "git-diff",
  "governance-rebuild",
  "graph",
  "gui",
  "init",
  "legacy-copy-safe-docs",
  "legacy-index",
  "legacy-intake-plan",
  "lesson-promote",
  "lesson-sediment",
  "materializer-run",
  "migrate-anchors",
  "migrate-provenance",
  "migrate-run",
  "migrate-structure",
  "module-register",
  "module-scaffold",
  "module-step",
  "module-unregister",
  "new-task",
  "preset-action",
  "preset-install",
  "preset-run",
  "preset-seed",
  "preset-uninstall",
  "progress-append",
  "record-fact",
  "runtime-event-append",
  "script-run",
  "session-backfill",
  "session-export",
  "session-sync",
  "task-amend",
  "task-archive",
  "task-delete",
  "task-relate",
  "task-reopen",
  "task-supersede",
  "worktree-create"
]);

const arbiterCliActionKinds = new Set<string>([
  "decision-accept",
  "decision-defer",
  "decision-reject",
  "decision-retire",
  "decision-supersede",
  "status-set",
  "task-complete",
  "task-review"
]);

export const repoCommandRunClassifiedActionKinds = [
  ...repoReadCliActionKinds,
  ...repoWriteCliActionKinds,
  ...arbiterCliActionKinds
].sort();

export function commandClassForJsonRpcRequest(
  contract: JsonRpcMethodContract,
  params: unknown
): DaemonCommandClass | undefined {
  if (contract.commandClassDerivation === "repo-command-run-action") {
    return commandClassForCliCommandPayload(params);
  }
  return contract.commandClass;
}

export function commandClassForCliCommandPayload(params: unknown): DaemonCommandClass | undefined {
  const payload = isRecord(params) ? params.payload : undefined;
  const command = isRecord(payload) ? payload.command : undefined;
  const action = isRecord(command) ? command.action : undefined;
  const kind = isRecord(action) && typeof action.kind === "string" ? action.kind : undefined;
  if (!kind) return undefined;
  if (repoReadCliActionKinds.has(kind)) return "repo-read";
  if (repoWriteCliActionKinds.has(kind)) return "repo-write";
  if (arbiterCliActionKinds.has(kind)) return "arbiter";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const jsonRpcServiceMethodContracts = deriveJsonRpcServiceMethodContracts();

export const jsonRpcMethodContracts = [
  ...protocolMethodContracts,
  ...cliCommandContracts,
  ...daemonStatusContracts,
  ...jsonRpcServiceMethodContracts,
  ...notificationStubContracts,
  ...adminReservedContracts
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;
