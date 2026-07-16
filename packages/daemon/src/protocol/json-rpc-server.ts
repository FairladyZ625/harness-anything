// @slice-activation PLT-Daemon W2 protocol core exported for W3 transport adapters.
import {
  isTaskHolderError,
  taskHolderPrincipalFromActor,
  type CommandFailureReceipt,
  type CommandReceipt,
  type DaemonControlRequestV1,
  type DaemonControlService,
  type DaemonStatusService,
  type DocSyncSubmitRequestV1,
  type DocSyncSubmitResultV1,
  type LocalControllerService,
  type TaskHolderExecutor,
  type TaskHolderService
} from "../../../application/src/index.ts";
import type { RuntimeEventAppendInput } from "../../../application/src/runtime-event-ledger-service.ts";
import type { TerminalSessionService } from "../../../gui/src/terminal/session-registry.ts";
import { commandClassForJsonRpcRequest, currentDaemonProtocolVersion, jsonRpcMethodContracts, type JsonRpcMethodContract } from "./method-registry.ts";
import { failureReceipt, serviceResultReceipt, successReceipt } from "./receipt-envelope.ts";
import { isJsonObject, type JsonObject, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse, type JsonValue } from "./json-rpc-types.ts";
import { readTaskHolderExecutor } from "./task-holder-payload.ts";
import { appendJsonRpcCommandEvent, appendJsonRpcWriteEventIfNeeded } from "./runtime-event-dispatch.ts";
import { commandRootMismatch, validateForcedCommandRoot } from "./forced-command-root.ts";
import { resolveIdentityActorForMethod } from "./identity-dispatch.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import {
  actorStampJson,
  type AuthenticatedActor,
  type IdentityAdminSnapshot,
  type IdentityProvider,
  type PersonRegistry
} from "../identity/types.ts";

export interface DaemonRepoNamespace {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

export interface DaemonRepoRuntimeSnapshot {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly state: "attached" | "unavailable" | "detaching" | "detached";
  readonly lockPath?: string;
  readonly lockOwnerToken?: string;
  readonly lastError?: string;
}

export interface DaemonRepoAvailabilityFailure {
  readonly code: "repo_lock_held" | "repo_unavailable";
  readonly repo: {
    readonly repoId: string;
    readonly canonicalRoot: string;
    readonly state: string;
    readonly lockPath: string | null;
    readonly lockOwnerToken: string | null;
    readonly lastError: string | null;
  };
}

export interface DaemonRepoServiceContext {
  readonly repo: DaemonRepoNamespace;
}

export interface DaemonServiceHost {
  readonly LocalControllerService: LocalControllerService;
  readonly TerminalSessionService: TerminalSessionService;
  readonly TaskHolderService?: TaskHolderService;
  readonly DaemonStatusService?: DaemonStatusService;
  readonly DaemonControlService?: DaemonControlService;
  readonly CliCommandService?: {
    readonly runCommand: (payload?: JsonObject, context?: { readonly actor?: AuthenticatedActor; readonly executor?: TaskHolderExecutor | null; readonly repo?: DaemonRepoNamespace }) => Promise<CommandReceipt | CommandFailureReceipt>;
  };
  readonly DocSyncService?: {
    readonly submit: (request: DocSyncSubmitRequestV1, context?: { readonly actor?: AuthenticatedActor; readonly executor?: TaskHolderExecutor | null; readonly repo?: DaemonRepoNamespace }) => Promise<DocSyncSubmitResultV1>;
  };
}

export interface JsonRpcServerOptions {
  readonly daemonId: string;
  readonly repos: ReadonlyArray<DaemonRepoNamespace>;
  readonly services: DaemonServiceHost;
  readonly resolveRepoServices?: (repo: DaemonRepoNamespace) => DaemonServiceHost | undefined;
  readonly resolveRepoAvailability?: (repo: DaemonRepoNamespace) => DaemonRepoAvailabilityFailure | undefined;
  /** Workspace policy resolver supplied by the CLI composition root. */
  readonly leaseEnforcementEnabled?: (repo: DaemonRepoNamespace) => boolean;
  readonly authContext?: DaemonAuthenticationContext;
  readonly identityProvider?: IdentityProvider;
  readonly personRegistry?: PersonRegistry;
  readonly identityAdminSnapshot?: IdentityAdminSnapshot;
  readonly resolveRepoIdentity?: (repo: DaemonRepoNamespace) => {
    readonly identityProvider?: IdentityProvider;
    readonly personRegistry?: PersonRegistry;
    readonly identityAdminSnapshot?: IdentityAdminSnapshot;
  } | undefined;
  readonly appendRuntimeEvent?: (input: RuntimeEventAppendInput, context?: DaemonRepoServiceContext) => Promise<void>;
  readonly enqueueAfterResponse?: (action: () => void) => void;
}

export interface JsonRpcProtocolServer {
  readonly handle: (message: JsonRpcRequest | JsonRpcRequest[]) =>
    Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>;
  readonly afterResponse?: () => void;
}

interface ProtocolSession {
  handshaken: boolean;
}

const methodByName: ReadonlyMap<string, JsonRpcMethodContract> = new Map(jsonRpcMethodContracts.map((contract) => [contract.method, contract]));

export function createJsonRpcProtocolServer(options: JsonRpcServerOptions): JsonRpcProtocolServer {
  const session: ProtocolSession = { handshaken: false };
  const repos = new Map(options.repos.map((repo) => [repo.repoId, repo]));
  const afterResponseActions: Array<() => void> = [];
  const requestOptions: JsonRpcServerOptions = {
    ...options,
    enqueueAfterResponse: (action) => afterResponseActions.push(action)
  };

  return {
    handle: async (message) => {
      if (Array.isArray(message)) {
        const responses = await Promise.all(message.map((request) => handleRequest(request, session, repos, requestOptions)));
        return responses.filter((response): response is JsonRpcResponse => response !== undefined);
      }
      return handleRequest(message, session, repos, requestOptions);
    },
    afterResponse: () => {
      for (const action of afterResponseActions.splice(0, afterResponseActions.length)) action();
    }
  };
}

async function handleRequest(
  request: JsonRpcRequest,
  session: ProtocolSession,
  repos: ReadonlyMap<string, DaemonRepoNamespace>,
  options: JsonRpcServerOptions
): Promise<JsonRpcResponse | undefined> {
  const id = request.id ?? null;
  if (!isJsonRpcRequest(request)) return errorResponse(id, -32600, "Invalid Request");

  const contract = methodByName.get(request.method);
  if (!contract) return errorResponse(id, -32601, "Method not found");

  const response = async (result: unknown): Promise<JsonRpcResponse | undefined> =>
    request.id === undefined ? undefined : { jsonrpc: "2.0", id, result };

  if (request.method === "protocol.hello") {
    return response(handleHello(request.params ?? {}, session, options, repos));
  }

  if (!session.handshaken) {
    return response(failureReceipt(request.method, "hello_required", "Call protocol.hello before any repo or admin method."));
  }

  if (contract.mode === "reserved") {
    return response(failureReceipt(request.method, "method_reserved", `Method namespace is reserved for future admin API: ${request.method}.`));
  }

  const params = request.params ?? {};
  const repoFailure = validateRepoNamespace(contract, params, repos);
  if (repoFailure) return response(failureReceipt(request.method, repoFailure.code, repoFailure.hint));
  const repo = repoForContract(contract, params, repos);
  const identityOptions = repoIdentityOptions(repo, options);
  const effectiveContract = withEffectiveCommandClass(contract, params);
  const forcedRootFailure = validateForcedCommandRoot(effectiveContract, params, repo, options.authContext);
  if (forcedRootFailure) return response(forcedRootFailure);
  const repoRuntimeFailure = validateRepoRuntime(effectiveContract, repo, options);
  if (repoRuntimeFailure) return response(repoRuntimeFailure);

  const actorResult = await resolveIdentityActorForMethod(effectiveContract, identityOptions);
  if (actorResult && !actorResult.ok) {
    const receipt = failureReceipt(request.method, actorResult.code, actorResult.message, {
      providerId: actorResult.providerId,
      ...(actorResult.credential ? { credential: credentialJson(actorResult.credential) } : {})
    });
    await appendJsonRpcCommandEvent(options, params, effectiveContract, "failed", actorResult.message, actorResult.code, undefined, repo);
    return response(receipt);
  }
  const actor = actorResult?.actor;
  if (actor && identityOptions.identityProvider) {
    const authz = await identityOptions.identityProvider.authorize({
      personId: actor.personId,
      action: { method: effectiveContract.method, commandClass: effectiveContract.commandClass },
      ...(repo ? { resource: { repoId: repo.repoId, canonicalRoot: repo.canonicalRoot } } : {})
    });
    if (!authz.ok) {
      await appendJsonRpcCommandEvent(options, params, effectiveContract, "failed", authz.message, authz.code, actor, repo);
      return response(stampReceipt(failureReceipt(request.method, authz.code, authz.message, {
        actor: actorStampJson(actor),
        commandClass: effectiveContract.commandClass ?? null
      }), actor));
    }
  }

  if (contract.mode === "notification-stub") {
    return response(stampReceipt(successReceipt(request.method, `registered no-op notification stub for ${request.method}`, {
      subscription: "noop"
    }), actor));
  }

  if (contract.namespace === "admin") {
    const result = await handleAdminMethod(contract, params, identityOptions);
    const receipt = stampReceipt(result, actor);
    await appendJsonRpcWriteEventIfNeeded(options, params, effectiveContract, receipt.ok ? "succeeded" : "failed", receipt.summary, receipt.ok ? undefined : receipt.error?.code, actor, repo);
    return response(receipt);
  }

  const result = await callServiceMethod(effectiveContract, params, options, actor, repo);
  const receipt = stampReceipt(result, actor);
  await appendJsonRpcWriteEventIfNeeded(options, params, effectiveContract, receipt.ok ? "succeeded" : "failed", receipt.summary, receipt.ok ? undefined : receipt.error?.code, actor, repo);
  return response(receipt);
}

function repoIdentityOptions(
  repo: DaemonRepoNamespace | undefined,
  options: JsonRpcServerOptions
): JsonRpcServerOptions {
  if (!repo || !options.resolveRepoIdentity) return options;
  const identity = options.resolveRepoIdentity(repo);
  if (!identity) {
    return {
      ...options,
      identityProvider: undefined,
      personRegistry: undefined,
      identityAdminSnapshot: undefined
    };
  }
  return { ...options, ...identity };
}

function handleHello(
  params: JsonObject,
  session: ProtocolSession,
  options: JsonRpcServerOptions,
  repos: ReadonlyMap<string, DaemonRepoNamespace>
): unknown {
  const requestedVersion = typeof params.protocolVersion === "number" ? params.protocolVersion : undefined;
  if (requestedVersion !== currentDaemonProtocolVersion) {
    return failureReceipt("protocol.hello", "incompatible_protocol_version", "Incompatible daemon protocol version.", {
      supported: { currentProtocolVersion: currentDaemonProtocolVersion },
      requested: { protocolVersion: requestedVersion ?? null }
    });
  }

  session.handshaken = true;
  return successReceipt("protocol.hello", "daemon protocol handshake accepted", {
    protocolVersion: currentDaemonProtocolVersion,
    daemon: options.daemonId,
    capabilities: ["json-rpc-2.0", "command-receipt/v2", "repo-namespace"],
    methods: jsonRpcMethodContracts.map((contract) => contract.method),
    repos: [...repos.values()].map((repo) => ({ repoId: repo.repoId, canonicalRoot: repo.canonicalRoot }))
  });
}

function validateRepoNamespace(
  contract: JsonRpcMethodContract,
  params: JsonObject,
  repos: ReadonlyMap<string, DaemonRepoNamespace>
): { readonly code: string; readonly hint: string } | undefined {
  if (!contract.requiresRepo) return undefined;
  const repo = params.repo;
  if (!isJsonObject(repo) || typeof repo.repoId !== "string") {
    return { code: "repo_namespace_required", hint: `Method ${contract.method} requires params.repo.repoId.` };
  }
  if (!repos.has(repo.repoId)) {
    return { code: "repo_namespace_unknown", hint: `Unknown repo namespace: ${repo.repoId}.` };
  }
  return undefined;
}

function repoForContract(
  contract: JsonRpcMethodContract,
  params: JsonObject,
  repos: ReadonlyMap<string, DaemonRepoNamespace>
): DaemonRepoNamespace | undefined {
  if (!contract.requiresRepo) return undefined;
  const repo = isJsonObject(params.repo) && typeof params.repo.repoId === "string" ? repos.get(params.repo.repoId) : undefined;
  return repo;
}

function validateRepoRuntime(
  contract: JsonRpcMethodContract,
  repo: DaemonRepoNamespace | undefined,
  options: JsonRpcServerOptions
): ReturnType<typeof failureReceipt> | undefined {
  if (!repo || !contract.requiresRepo || !options.resolveRepoAvailability || doesNotRequireAttachedRepo(contract)) return undefined;
  const failure = options.resolveRepoAvailability(repo);
  if (!failure) return undefined;
  return failureReceipt(contract.method, failure.code, `Repo ${repo.repoId} is not attached to this daemon.`, { repo: failure.repo });
}

function doesNotRequireAttachedRepo(contract: JsonRpcMethodContract): boolean {
  return contract.method === "repo.daemon.status" || contract.mode === "notification-stub";
}

async function callServiceMethod(
  contract: JsonRpcMethodContract,
  params: JsonObject,
  options: JsonRpcServerOptions,
  actor: AuthenticatedActor | undefined,
  repo: DaemonRepoNamespace | undefined
): Promise<ReturnType<typeof successReceipt> | ReturnType<typeof failureReceipt>> {
  const payload = isJsonObject(params.payload) ? params.payload : undefined;
  if (contract.method === "repo.command.run" && repo) {
    const rootMismatch = commandRootMismatch(payload, repo, options.authContext);
    if (rootMismatch) return rootMismatch;
  }
  const services = repo ? resolveServicesForRepo(contract.method, repo, options) : options.services;
  if (!services) return failureReceipt(contract.method, "repo_service_unavailable", `Repo service host is not configured for ${repo?.repoId ?? "unknown"}.`);
  if (contract.method === "repo.daemon.status") {
    if (!services.DaemonStatusService) {
      return failureReceipt(contract.method, "daemon_status_service_unavailable", "Daemon status service is not configured.");
    }
    return successReceipt(contract.method, "read daemon status", await services.DaemonStatusService.getStatus(repo ? { repo } : undefined) as unknown as JsonObject);
  }
  if (contract.method === "repo.command.run") {
    if (!services.CliCommandService) {
      return failureReceipt(contract.method, "cli_command_service_unavailable", "Daemon command service is not configured.");
    }
    return services.CliCommandService.runCommand(payload, { actor, executor: readTaskHolderExecutor(payload), repo });
  }
  if (contract.method === "repo.task.claim" || contract.method === "repo.task.holder" || contract.method === "repo.task.release") {
    return callTaskHolderMethod(contract, payload, services, actor);
  }
  if (contract.method === "repo.doc.sync.submit") {
    if (!services.DocSyncService) {
      return failureReceipt(contract.method, "doc_sync_service_unavailable", "Doc sync submit service is not configured.");
    }
    const result = await services.DocSyncService.submit(params as unknown as DocSyncSubmitRequestV1, {
      actor,
      executor: readTaskHolderExecutor(params as JsonObject),
      repo
    });
    return result.ok
      ? successReceipt(contract.method, `completed ${contract.method}`, result as unknown as JsonObject)
      : failureReceipt(contract.method, result.code, result.reason, { data: result as unknown as JsonObject });
  }
  const taskLeaseFailure = await validateTaskLeaseForServiceWrite(contract, payload, services, actor, repo, options);
  if (taskLeaseFailure) return taskLeaseFailure;
  const result = contract.service === "TerminalSessionService"
    ? await invokeServiceMethod(services.TerminalSessionService, String(contract.serviceMethod), payload)
    : await invokeServiceMethod(services.LocalControllerService, String(contract.serviceMethod), payload, actor);
  return isJsonObject(result)
    ? serviceResultReceipt(contract.method, result)
    : successReceipt(contract.method, `completed ${contract.method}`, { value: toJsonValue(result) });
}

async function callTaskHolderMethod(
  contract: JsonRpcMethodContract,
  payload: JsonObject | undefined,
  services: DaemonServiceHost,
  actor: AuthenticatedActor | undefined
): Promise<ReturnType<typeof successReceipt> | ReturnType<typeof failureReceipt>> {
  if (!services.TaskHolderService) {
    return failureReceipt(contract.method, "task_holder_service_unavailable", "Task holder service is not configured.");
  }
  const taskId = typeof payload?.taskId === "string" ? payload.taskId : undefined;
  if (!taskId) return failureReceipt(contract.method, "task_id_required", "Task holder methods require payload.taskId.");
  try {
    if (contract.method === "repo.task.holder") {
      return successReceipt(contract.method, "read task holder", toJsonValue(await services.TaskHolderService.holder({ taskId })) as JsonObject);
    }
    if (!actor) return failureReceipt(contract.method, "actor_required", "Task holder writes require a per-request authenticated actor.");
    const executor = readTaskHolderExecutor(payload);
    const principal = taskHolderPrincipalFromActor(actor, { executor });
    if (contract.method === "repo.task.claim") {
      const ttlMs = typeof payload?.ttlMs === "number" ? payload.ttlMs : undefined;
      return successReceipt(contract.method, "claimed task", toJsonValue(await services.TaskHolderService.claim({ taskId, principal, ttlMs })) as JsonObject);
    }
    return successReceipt(contract.method, "released task holder", toJsonValue(await services.TaskHolderService.release({ taskId, principal })) as JsonObject);
  } catch (error) {
    if (isTaskHolderError(error)) {
      return failureReceipt(contract.method, error.code, error.message, taskHolderErrorDetails(error));
    }
    return failureReceipt(contract.method, "task_holder_failed", error instanceof Error ? error.message : String(error));
  }
}

function taskHolderErrorDetails(error: {
  readonly code: string;
  readonly taskId: string;
  readonly holder?: unknown;
  readonly principal?: unknown;
  readonly leaseExpiresAt?: string | null;
  readonly orphan?: boolean;
}): JsonObject {
  return {
    taskId: error.taskId,
    code: error.code,
    ...(error.holder ? { holder: toJsonValue(error.holder) } : {}),
    ...(error.principal ? { principal: toJsonValue(error.principal) } : {}),
    leaseExpiresAt: error.leaseExpiresAt ?? null,
    ...(typeof error.orphan === "boolean" ? { orphan: error.orphan } : {})
  };
}

async function validateTaskLeaseForServiceWrite(
  contract: JsonRpcMethodContract,
  payload: JsonObject | undefined,
  services: DaemonServiceHost,
  actor: AuthenticatedActor | undefined,
  repo: DaemonRepoNamespace | undefined,
  options: JsonRpcServerOptions
): Promise<ReturnType<typeof failureReceipt> | undefined> {
  if (!repo || !options.leaseEnforcementEnabled?.(repo) || contract.leaseRequired !== true) return undefined;
  const taskId = typeof payload?.taskId === "string" ? payload.taskId : undefined;
  if (!taskId) return failureReceipt(contract.method, "task_id_required", "Task lease enforcement requires payload.taskId.");
  if (!services.TaskHolderService) {
    return failureReceipt(contract.method, "task_holder_service_unavailable", "Task holder service is not configured.");
  }
  if (!actor) return failureReceipt(contract.method, "actor_required", "Task lease enforcement requires a per-request authenticated actor.");
  try {
    const executor = readTaskHolderExecutor(payload);
    await services.TaskHolderService.assertActiveLease({ taskId, principal: taskHolderPrincipalFromActor(actor, { executor }) });
    return undefined;
  } catch (error) {
    if (isTaskHolderError(error)) {
      return failureReceipt(contract.method, error.code, error.message, taskHolderErrorDetails(error));
    }
    return failureReceipt(contract.method, "task_holder_failed", error instanceof Error ? error.message : String(error));
  }
}

function resolveServicesForRepo(
  method: string,
  repo: DaemonRepoNamespace,
  options: JsonRpcServerOptions
): DaemonServiceHost | undefined {
  if (!options.resolveRepoServices) return options.services;
  return options.resolveRepoServices(repo) ?? (method === "repo.daemon.status" ? options.services : undefined);
}

function withEffectiveCommandClass(contract: JsonRpcMethodContract, params: JsonObject): JsonRpcMethodContract {
  const commandClass = commandClassForJsonRpcRequest(contract, params);
  if (commandClass === contract.commandClass) return contract;
  return commandClass ? { ...contract, commandClass } : { ...contract };
}

async function handleAdminMethod(
  contract: JsonRpcMethodContract,
  params: JsonObject,
  options: JsonRpcServerOptions
): Promise<ReturnType<typeof successReceipt> | ReturnType<typeof failureReceipt>> {
  if (contract.method === "admin.daemon.restart" || contract.method === "admin.daemon.refresh") {
    if (!options.services.DaemonControlService) {
      return failureReceipt(contract.method, "daemon_control_unavailable", "Daemon control service is not configured. Run `ha daemon status --json` to verify the reachable service before retrying.");
    }
    const payload = isJsonObject(params.payload) ? params.payload : {};
    const request = daemonControlRequest(contract.method, payload);
    if (!request.ok) return failureReceipt(contract.method, request.code, request.hint);
    const result = await options.services.DaemonControlService.requestControl(
      contract.method === "admin.daemon.restart" ? "restart" : "refresh",
      request.value
    );
    if (!result.ok) {
      return failureReceipt(contract.method, result.error.code, result.error.hint, {
        operationId: result.error.operationId
      });
    }
    options.enqueueAfterResponse?.(result.afterResponse);
    return successReceipt(contract.method, `accepted daemon ${result.accepted.kind}`, toJsonValue(result.accepted) as JsonObject);
  }
  if (!options.identityAdminSnapshot) {
    return failureReceipt(contract.method, "people_roster_unavailable", "Admin identity methods require a loaded people roster.");
  }
  if (contract.method === "admin.people.list") {
    return successReceipt(contract.method, "listed people", {
      items: options.identityAdminSnapshot.people.map((person) => ({
        personId: person.personId,
        displayName: person.displayName,
        ...(person.primaryEmail ? { primaryEmail: person.primaryEmail } : {}),
        roles: [...person.roles],
        disabled: person.disabled ?? false,
        credentials: person.credentials.map(credentialJson)
      }))
    });
  }
  if (contract.method === "admin.rbac.roles.list") {
    return successReceipt(contract.method, "listed RBAC roles", {
      items: options.identityAdminSnapshot.roles.map((role) => ({
        roleId: role.roleId,
        commandClasses: [...role.commandClasses]
      }))
    });
  }
  return failureReceipt(contract.method, "method_not_implemented", `Admin method is not implemented: ${contract.method}`);
}

function daemonControlRequest(
  method: "admin.daemon.restart" | "admin.daemon.refresh",
  payload: JsonObject
): { readonly ok: true; readonly value: DaemonControlRequestV1 } | { readonly ok: false; readonly code: string; readonly hint: string } {
  const cliCommand = method === "admin.daemon.refresh" ? "ha daemon refresh" : "ha daemon restart";
  if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
    return { ok: false, code: "daemon_control_unavailable", hint: `${method} requires payload.reason. Retry with \`${cliCommand} --reason "operator request"\`.` };
  }
  if (!Number.isSafeInteger(payload.drainTimeoutMs) || Number(payload.drainTimeoutMs) < 100 || Number(payload.drainTimeoutMs) > 120_000) {
    return { ok: false, code: "daemon_control_unavailable", hint: `${method} requires payload.drainTimeoutMs from 100 through 120000. Retry with \`${cliCommand} --timeout-ms 5000\`.` };
  }
  if (method === "admin.daemon.refresh"
    && payload.trigger !== "explicit"
    && payload.trigger !== "post-merge"
    && payload.trigger !== "dist-watcher") {
    return { ok: false, code: "daemon_control_unavailable", hint: `${method} requires payload.trigger explicit|post-merge|dist-watcher. Retry with \`ha daemon refresh --trigger explicit\`.` };
  }
  return {
    ok: true,
    value: {
      reason: payload.reason,
      drainTimeoutMs: Number(payload.drainTimeoutMs),
      ...(method === "admin.daemon.refresh" ? { trigger: payload.trigger as DaemonControlRequestV1["trigger"] } : {})
    }
  };
}

function stampReceipt<T extends ReturnType<typeof successReceipt> | ReturnType<typeof failureReceipt>>(receipt: T, actor?: AuthenticatedActor): T {
  if (!actor) return receipt;
  return {
    ...receipt,
    details: {
      ...(receipt.details ?? {}),
      actor: actorStampJson(actor)
    }
  };
}

function credentialJson(credential: { readonly kind: string; readonly issuer: string; readonly subject: string }): JsonObject {
  return {
    kind: credential.kind,
    issuer: credential.issuer,
    subject: credential.subject
  };
}

async function invokeServiceMethod(
  service: object,
  methodName: string,
  payload: JsonObject | undefined,
  actor?: AuthenticatedActor
): Promise<unknown> {
  const method = (service as Record<string, (payload?: JsonObject, context?: { readonly actor?: AuthenticatedActor }) => unknown>)[methodName];
  return method.length === 0 ? await method() : await method(payload, actor ? { actor } : undefined);
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isJsonObject(value) && value.jsonrpc === "2.0" && typeof value.method === "string";
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isJsonObject(value)) return value;
  return String(value);
}
