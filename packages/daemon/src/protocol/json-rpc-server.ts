// @slice-activation PLT-Daemon W2 protocol core exported for W3 transport adapters.
import type { LocalControllerService } from "../../../application/src/index.ts";
import type { TerminalSessionService } from "../../../gui/src/terminal/session-registry.ts";
import { currentDaemonProtocolVersion, jsonRpcMethodContracts, type JsonRpcMethodContract } from "./method-registry.ts";
import { failureReceipt, serviceResultReceipt, successReceipt } from "./receipt-envelope.ts";
import { isJsonObject, type JsonObject, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse, type JsonValue } from "./json-rpc-types.ts";

export interface DaemonRepoNamespace {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

export interface DaemonServiceHost {
  readonly LocalControllerService: LocalControllerService;
  readonly TerminalSessionService: TerminalSessionService;
}

export interface JsonRpcServerOptions {
  readonly daemonId: string;
  readonly repos: ReadonlyArray<DaemonRepoNamespace>;
  readonly services: DaemonServiceHost;
}

export interface JsonRpcProtocolServer {
  readonly handle: (message: JsonRpcRequest | JsonRpcRequest[]) =>
    Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>;
}

interface ProtocolSession {
  handshaken: boolean;
}

const methodByName = new Map(jsonRpcMethodContracts.map((contract) => [contract.method, contract]));

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

  const repoFailure = validateRepoNamespace(contract, request.params ?? {}, repos);
  if (repoFailure) return response(failureReceipt(request.method, repoFailure.code, repoFailure.hint));

  if (contract.mode === "notification-stub") {
    return response(successReceipt(request.method, `registered no-op notification stub for ${request.method}`, {
      subscription: "noop"
    }));
  }

  return response(await callServiceMethod(contract, request.params ?? {}, options.services));
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

async function callServiceMethod(
  contract: JsonRpcMethodContract,
  params: JsonObject,
  services: DaemonServiceHost
): Promise<unknown> {
  const payload = isJsonObject(params.payload) ? params.payload : undefined;
  const result = contract.service === "TerminalSessionService"
    ? await invokeServiceMethod(services.TerminalSessionService, String(contract.serviceMethod), payload)
    : await invokeServiceMethod(services.LocalControllerService, String(contract.serviceMethod), payload);
  return isJsonObject(result)
    ? serviceResultReceipt(contract.method, result)
    : successReceipt(contract.method, `completed ${contract.method}`, { value: toJsonValue(result) });
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
