// @slice-activation PLT-Daemon W2 protocol core exported for W3 transport adapters.
import { realpathSync } from "node:fs";
import path from "node:path";
import type { CommandFailureReceipt, CommandReceipt, DocSyncSubmitRequestV1, DocSyncSubmitResultV1, LocalControllerService } from "../../../application/src/index.ts";
import type { RuntimeEventAppendInput } from "../../../application/src/runtime-event-ledger-service.ts";
import type { TerminalSessionService } from "../../../gui/src/terminal/session-registry.ts";
import { commandClassForJsonRpcRequest, currentDaemonProtocolVersion, jsonRpcMethodContracts, type JsonRpcMethodContract } from "./method-registry.ts";
import { failureReceipt, serviceResultReceipt, successReceipt } from "./receipt-envelope.ts";
import { isJsonObject, type JsonObject, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse, type JsonValue } from "./json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { authorizeActorForMethod } from "../identity/authorization.ts";
import { actorStamp, actorStampJson, type AuthenticatedActor, type IdentityProvider, type PeopleRoster } from "../identity/types.ts";

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
  readonly DaemonStatusService?: {
    readonly getStatus: (context?: DaemonRepoServiceContext) => JsonObject | Promise<JsonObject>;
  };
  readonly CliCommandService?: {
    readonly runCommand: (payload?: JsonObject, context?: { readonly actor?: AuthenticatedActor; readonly repo?: DaemonRepoNamespace }) => Promise<CommandReceipt | CommandFailureReceipt>;
  };
  readonly DocSyncService?: {
    readonly submit: (request: DocSyncSubmitRequestV1, context?: { readonly actor?: AuthenticatedActor; readonly repo?: DaemonRepoNamespace }) => Promise<DocSyncSubmitResultV1>;
  };
}

export interface JsonRpcServerOptions {
  readonly daemonId: string;
  readonly repos: ReadonlyArray<DaemonRepoNamespace>;
  readonly services: DaemonServiceHost;
  readonly resolveRepoServices?: (repo: DaemonRepoNamespace) => DaemonServiceHost | undefined;
  readonly resolveRepoAvailability?: (repo: DaemonRepoNamespace) => DaemonRepoAvailabilityFailure | undefined;
  readonly authContext?: DaemonAuthenticationContext;
  readonly identityProvider?: IdentityProvider;
  readonly peopleRoster?: PeopleRoster;
  readonly appendRuntimeEvent?: (input: RuntimeEventAppendInput, context?: DaemonRepoServiceContext) => Promise<void>;
}

export interface JsonRpcProtocolServer {
  readonly handle: (message: JsonRpcRequest | JsonRpcRequest[]) =>
    Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>;
}

interface ProtocolSession {
  handshaken: boolean;
}

const methodByName: ReadonlyMap<string, JsonRpcMethodContract> = new Map(jsonRpcMethodContracts.map((contract) => [contract.method, contract]));

export function createJsonRpcProtocolServer(options: JsonRpcServerOptions): JsonRpcProtocolServer {
  const session: ProtocolSession = { handshaken: false };
  const repos = new Map(options.repos.map((repo) => [repo.repoId, repo]));

  return {
    handle: async (message) => {
      if (Array.isArray(message)) {
        const responses = await Promise.all(message.map((request) => handleRequest(request, session, repos, options)));
        return responses.filter((response): response is JsonRpcResponse => response !== undefined);
      }
      return handleRequest(message, session, repos, options);
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
  const effectiveContract = withEffectiveCommandClass(contract, params);
  const repoRuntimeFailure = validateRepoRuntime(effectiveContract, repo, options);
  if (repoRuntimeFailure) return response(repoRuntimeFailure);

  const actorResult = await resolveActor(effectiveContract, options);
  if (actorResult && !actorResult.ok) {
    const receipt = failureReceipt(request.method, actorResult.code, actorResult.message, {
      providerId: actorResult.providerId,
      ...(actorResult.credential ? { credential: credentialJson(actorResult.credential) } : {})
    });
    await appendCommandEvent(options, params, effectiveContract, "failed", actorResult.message, actorResult.code, undefined, repo);
    return response(receipt);
  }
  const actor = actorResult?.actor;
  if (actor && options.peopleRoster) {
    const authz = authorizeActorForMethod(actor, effectiveContract, options.peopleRoster);
    if (!authz.ok) {
      await appendCommandEvent(options, params, effectiveContract, "failed", authz.message, authz.code, actor, repo);
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
    const result = handleAdminMethod(contract, options);
    const receipt = stampReceipt(result, actor);
    await appendWriteEventIfNeeded(options, params, effectiveContract, receipt.ok ? "succeeded" : "failed", receipt.summary, receipt.ok ? undefined : receipt.error?.code, actor, repo);
    return response(receipt);
  }

  const result = await callServiceMethod(effectiveContract, params, options, actor, repo);
  const receipt = stampReceipt(result, actor);
  await appendWriteEventIfNeeded(options, params, effectiveContract, receipt.ok ? "succeeded" : "failed", receipt.summary, receipt.ok ? undefined : receipt.error?.code, actor, repo);
  return response(receipt);
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
  const services = repo ? resolveServicesForRepo(contract.method, repo, options) : options.services;
  if (!services) return failureReceipt(contract.method, "repo_service_unavailable", `Repo service host is not configured for ${repo?.repoId ?? "unknown"}.`);
  if (contract.method === "repo.daemon.status") {
    if (!services.DaemonStatusService) {
      return failureReceipt(contract.method, "daemon_status_service_unavailable", "Daemon status service is not configured.");
    }
    return successReceipt(contract.method, "read daemon status", await services.DaemonStatusService.getStatus(repo ? { repo } : undefined));
  }
  if (contract.method === "repo.command.run") {
    if (!services.CliCommandService) {
      return failureReceipt(contract.method, "cli_command_service_unavailable", "Daemon command service is not configured.");
    }
    const rootMismatch = repo ? commandRootMismatch(payload, repo) : undefined;
    if (rootMismatch) return rootMismatch;
    return services.CliCommandService.runCommand(payload, { actor, repo });
  }
  if (contract.method === "repo.doc.sync.submit") {
    if (!services.DocSyncService) {
      return failureReceipt(contract.method, "doc_sync_service_unavailable", "Doc sync submit service is not configured.");
    }
    const result = await services.DocSyncService.submit(params as unknown as DocSyncSubmitRequestV1, { actor, repo });
    return result.ok
      ? successReceipt(contract.method, `completed ${contract.method}`, result as unknown as JsonObject)
      : failureReceipt(contract.method, result.code, result.reason, { data: result as unknown as JsonObject });
  }
  const result = contract.service === "TerminalSessionService"
    ? await invokeServiceMethod(services.TerminalSessionService, String(contract.serviceMethod), payload)
    : await invokeServiceMethod(services.LocalControllerService, String(contract.serviceMethod), payload);
  return isJsonObject(result)
    ? serviceResultReceipt(contract.method, result)
    : successReceipt(contract.method, `completed ${contract.method}`, { value: toJsonValue(result) });
}

function resolveServicesForRepo(
  method: string,
  repo: DaemonRepoNamespace,
  options: JsonRpcServerOptions
): DaemonServiceHost | undefined {
  if (!options.resolveRepoServices) return options.services;
  return options.resolveRepoServices(repo) ?? (method === "repo.daemon.status" ? options.services : undefined);
}

function commandRootMismatch(payload: JsonObject | undefined, repo: DaemonRepoNamespace): ReturnType<typeof failureReceipt> | undefined {
  const command = isJsonObject(payload?.command) ? payload.command : undefined;
  const rootDir = typeof command?.rootDir === "string" ? command.rootDir : undefined;
  if (!rootDir) return undefined;
  if (realpathOrResolve(rootDir) === realpathOrResolve(repo.canonicalRoot)) return undefined;
  return failureReceipt("repo.command.run", "repo_command_root_mismatch", "payload.command.rootDir does not match params.repo.repoId.", {
    repo: { repoId: repo.repoId, canonicalRoot: repo.canonicalRoot },
    command: { rootDir }
  });
}

function realpathOrResolve(rootDir: string): string {
  try {
    return realpathSync.native(rootDir);
  } catch {
    return path.resolve(rootDir);
  }
}

function withEffectiveCommandClass(contract: JsonRpcMethodContract, params: JsonObject): JsonRpcMethodContract {
  const commandClass = commandClassForJsonRpcRequest(contract, params);
  if (commandClass === contract.commandClass) return contract;
  return commandClass ? { ...contract, commandClass } : { ...contract };
}

async function resolveActor(
  contract: JsonRpcMethodContract,
  options: JsonRpcServerOptions
): Promise<{ readonly ok: true; readonly actor: AuthenticatedActor } | Awaited<ReturnType<IdentityProvider["resolveActor"]>> | undefined> {
  if (!options.identityProvider) return undefined;
  const authContext = options.authContext ?? { transportKind: "unix-socket" } satisfies DaemonAuthenticationContext;
  return options.identityProvider.resolveActor({
    authContext,
    command: {
      method: contract.method,
      namespace: contract.namespace,
      requiresRepo: contract.requiresRepo
    }
  });
}

function handleAdminMethod(
  contract: JsonRpcMethodContract,
  options: JsonRpcServerOptions
): ReturnType<typeof successReceipt> | ReturnType<typeof failureReceipt> {
  if (!options.peopleRoster) {
    return failureReceipt(contract.method, "people_roster_unavailable", "Admin identity methods require a loaded people roster.");
  }
  if (contract.method === "admin.people.list") {
    return successReceipt(contract.method, "listed people", {
      items: options.peopleRoster.people.map((person) => ({
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
      items: options.peopleRoster.roles.map((role) => ({
        roleId: role.roleId,
        commandClasses: [...role.commandClasses]
      }))
    });
  }
  return failureReceipt(contract.method, "method_not_implemented", `Admin method is not implemented: ${contract.method}`);
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

async function appendWriteEventIfNeeded(
  options: JsonRpcServerOptions,
  params: JsonObject,
  contract: JsonRpcMethodContract,
  status: "succeeded" | "failed",
  summary: string,
  errorCode: string | undefined,
  actor: AuthenticatedActor | undefined,
  repo: DaemonRepoNamespace | undefined
): Promise<void> {
  if (contract.commandClass === "repo-read") return;
  await appendCommandEvent(options, params, contract, status, summary, errorCode, actor, repo);
}

async function appendCommandEvent(
  options: JsonRpcServerOptions,
  params: JsonObject,
  contract: JsonRpcMethodContract,
  status: "succeeded" | "failed",
  summary: string,
  errorCode?: string,
  actor?: AuthenticatedActor,
  repo?: DaemonRepoNamespace
): Promise<void> {
  if (!options.appendRuntimeEvent) return;
  const session = runtimeSession(params, options.daemonId);
  await options.appendRuntimeEvent({
    kind: "result",
    actorAxes: actorAxes(session, actor),
    session,
    tool: {
      toolName: contract.method,
      ...(errorCode ? { errorCode } : {})
    },
    result: {
      status,
      summary,
      ...(errorCode ? { errorCode } : {})
    },
    ...(actor ? { actor: actorStamp(actor) } : {})
  }, repo ? { repo } : undefined).catch(() => undefined);
}

function actorAxes(session: ReturnType<typeof runtimeSession>, actor: AuthenticatedActor | undefined): RuntimeEventAppendInput["actorAxes"] {
  const principal = actor ? actorStamp(actor) : null;
  return {
    principal,
    executor: { runtime: session.runtime, sessionId: session.sessionId },
    responsibleHuman: principal
  };
}

function runtimeSession(params: JsonObject, daemonId: string): { readonly sessionId: string; readonly runtime: "human" | "claude-code" | "codex" | "zcode" | "antigravity" | "unknown" } {
  const session = isJsonObject(params.session) ? params.session : {};
  const runtime = typeof session.runtime === "string" && ["human", "claude-code", "codex", "zcode", "antigravity"].includes(session.runtime)
    ? session.runtime as "human" | "claude-code" | "codex" | "zcode" | "antigravity"
    : "unknown";
  return {
    sessionId: typeof session.sessionId === "string" && session.sessionId.trim() ? session.sessionId : `daemon-${daemonId}`,
    runtime
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
  payload: JsonObject | undefined
): Promise<unknown> {
  const method = (service as Record<string, (payload?: JsonObject) => unknown>)[methodName];
  return method.length === 0 ? await method() : await method(payload);
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
