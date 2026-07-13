import { apiRouteContracts, type ApiRouteContract } from "../../../gui/src/api/api-contract-registry.ts";
import { taskWriteCliRoutePolicies, taskWriteCliRoutePolicy } from "../../../application/src/index.ts";
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
  readonly leaseRequired?: boolean;
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

const docSyncContracts = [
  {
    method: "repo.doc.sync.submit",
    mode: "active",
    namespace: "repo",
    inputSchemaId: "daemon.doc-sync-submit-request/v1",
    outputSchemaId: "daemon.doc-sync-submit-result/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true,
    commandClass: "repo-write"
  }
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;

const taskHolderContracts = [
  {
    method: "repo.task.claim",
    mode: "active",
    namespace: "repo",
    inputSchemaId: "daemon.task-holder-claim/v1",
    outputSchemaId: "application.task-holder-claim-result/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true,
    commandClass: "repo-write"
  },
  {
    method: "repo.task.holder",
    mode: "active",
    namespace: "repo",
    inputSchemaId: "daemon.task-holder-read/v1",
    outputSchemaId: "application.task-holder-snapshot/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true,
    commandClass: "repo-read"
  },
  {
    method: "repo.task.release",
    mode: "active",
    namespace: "repo",
    inputSchemaId: "daemon.task-holder-release/v1",
    outputSchemaId: "application.task-holder-release-result/v1",
    errorSchemaId: "daemon.protocol-error/v1",
    auth: "local-session-token",
    requiresRepo: true,
    commandClass: "repo-write"
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
    commandClass: commandClassForApiRoute(contract),
    ...(contract.leaseRequired === true ? { leaseRequired: true } : {})
  }));
}

export function commandClassForApiRoute(contract: ApiRouteContract): DaemonCommandClass {
  if (contract.commandClass) return contract.commandClass;
  if (contract.method === "GET" || contract.method === "WS") return "repo-read";
  return "repo-write";
}

const repoReadCliActionKinds = new Set<string>([
  "audit-provenance",
  "capabilities",
  "check",
  "decision-list",
  "decision-show",
  "diagnostics-command-usage",
  "doc-status",
  "doc-sync-dry-run",
  "doctor",
  "entity-list",
  "execution-list",
  "execution-show",
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
  "review-show",
  "runtime-event-list",
  "script-inspect",
  "script-list",
  "session-show",
  "session-trace",
  "snapshot-multica",
  "status",
  "task-holder",
  "task-list",
  "task-show",
  "task-trace",
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
  "migrate-fact-execution",
  "migrate-provenance",
  "migrate-run",
  "migrate-structure",
  "module-register",
  "module-scaffold",
  "module-step",
  "module-unregister",
  "preset-action",
  "preset-install",
  "preset-run",
  "preset-seed",
  "preset-uninstall",
  "record-fact",
  "runtime-event-append",
  "script-run",
  "session-backfill",
  "session-export",
  "session-sync",
  "worktree-create"
]);

const arbiterCliActionKinds = new Set<string>([
  "decision-accept",
  "decision-defer",
  "decision-reject",
  "decision-retire",
  "decision-supersede",
  "task-review-execution",
]);

export const repoCommandRunClassifiedActionKinds = [
  ...repoReadCliActionKinds,
  ...repoWriteCliActionKinds,
  ...arbiterCliActionKinds,
  ...taskWriteCliRoutePolicies.map((policy) => policy.actionKind)
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
  return commandClassForCliActionKind(kind);
}

export function commandClassForCliActionKind(kind: string): DaemonCommandClass | undefined {
  const taskWritePolicy = taskWriteCliRoutePolicy(kind);
  if (taskWritePolicy) return taskWritePolicy.commandClass;
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
  ...docSyncContracts,
  ...taskHolderContracts,
  ...jsonRpcServiceMethodContracts,
  ...notificationStubContracts,
  ...adminReservedContracts
] as const satisfies ReadonlyArray<JsonRpcMethodContract>;
