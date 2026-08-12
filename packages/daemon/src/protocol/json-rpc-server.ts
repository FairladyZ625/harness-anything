import type { DaemonHost } from "../daemon-host.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { currentDaemonProtocolVersion, jsonRpcMethodContracts } from "./method-registry.ts";
import { isJsonObject, type JsonObject, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse } from "./json-rpc-types.ts";

export interface JsonRpcProtocolServer { readonly handle: (message: JsonRpcRequest | JsonRpcRequest[]) => Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> }
export function createJsonRpcProtocolServer(options: { readonly host: DaemonHost; readonly authContext: DaemonAuthenticationContext }): JsonRpcProtocolServer {
  let handshaken = false;
  const one = async (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(id, -32600, "Invalid Request");
    if (!jsonRpcMethodContracts.some((entry) => entry.method === request.method)) return rpcError(id, -32601, "Method not found");
    const reply = (result: JsonObject): JsonRpcResponse | undefined => request.id === undefined ? undefined : { jsonrpc: "2.0", id, result };
    if (request.method === "protocol.hello") {
      if (request.params?.protocolVersion !== currentDaemonProtocolVersion) return reply(failure("protocol.hello", "incompatible_protocol_version", "Use the daemon protocol version reported by this binary."));
      handshaken = true; return reply({ ok: true, protocolVersion: currentDaemonProtocolVersion, methods: jsonRpcMethodContracts.map((entry) => entry.method) });
    }
    if (!handshaken) return reply(failure(request.method, "hello_required", "Call protocol.hello first."));
    if (request.method === "daemon.status") return reply({ ok: true, ...options.host.status() } as unknown as JsonObject);
    if (request.method === "daemon.repo.bootstrap") {
      const params = request.params;
      if (!params || typeof params.rootDir !== "string" || typeof params.repoId !== "string" || typeof params.personId !== "string" || typeof params.displayName !== "string") {
        return reply(failure("init", "invalid_request", "rootDir, repoId, personId, and displayName are required."));
      }
      try { return reply(await options.host.bootstrap(params as unknown as { rootDir: string; repoId: string; personId: string; displayName: string }, options.authContext) as JsonObject); }
      catch (error) { return reply(failure("init", rpcServerErrorCode(error), error instanceof Error ? error.message : String(error))); }
    }
    if (request.method === "daemon.repo.register" || request.method === "daemon.repo.unregister") { const params = request.params;
      if (!params || typeof params.repoId !== "string" || (request.method.endsWith("register") && !request.method.endsWith("unregister") && typeof params.rootDir !== "string")) return reply(failure(request.method, "invalid_request", "repoId and register rootDir are required."));
      try { return reply(await options.host.admin(request.method.endsWith("unregister") ? { kind: "unregister", repoId: params.repoId } : { kind: "register", repoId: params.repoId, rootDir: params.rootDir as string }) as JsonObject); }
      catch (error) { return reply(failure(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error))); }
    }
    const repo = isJsonObject(request.params?.repo) && typeof request.params.repo.repoId === "string" ? request.params.repo.repoId : undefined;
    const action = isJsonObject(request.params?.payload) && isJsonObject(request.params.payload.action) ? request.params.payload.action : undefined;
    if (!repo || !action || typeof action.kind !== "string") return reply(failure(request.method, "invalid_request", "repoId and action are required."));
    const receipt = await options.host.run(repo, action as { readonly kind: string }, options.authContext);
    const ok = receipt.outcome === "applied" || receipt.outcome === "pending";
    return reply({ schema: "command-receipt/v2", ok, command: action.kind, ...receipt,
      ...(!ok ? { error: { code: receipt.code ?? "write_rejected", hint: receipt.nextAction ?? "Inspect the rejection." } } : {}) } as unknown as JsonObject);
  };
  return { handle: async (message) => Array.isArray(message)
    ? (await Promise.all(message.map(one))).filter((item): item is JsonRpcResponse => item !== undefined) : one(message) };
}
function rpcError(id: JsonRpcId, errorCode: number, message: string): JsonRpcResponse { return { jsonrpc: "2.0", id, error: { code: errorCode, message } }; }
function failure(command: string, errorCode: string, nextAction: string): JsonObject { return { schema: "command-receipt/v2", ok: false, command,
  outcome: "rejected", error: { code: errorCode, hint: nextAction }, nextAction }; }
function rpcServerErrorCode(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "bootstrap_failed"; }
