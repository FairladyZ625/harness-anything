import type { DaemonHost } from "../daemon-host.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { isDaemonGuiReadMethod, jsonRpcMethodContracts, parseDaemonRpcParams } from "./daemon-protocol.contract.ts";
import { type JsonObject, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse } from "./json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./version.ts";

export interface JsonRpcProtocolServer { readonly handle: (message: JsonRpcRequest | JsonRpcRequest[]) => Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> }
export function createJsonRpcProtocolServer(options: { readonly host: DaemonHost; readonly authContext: DaemonAuthenticationContext }): JsonRpcProtocolServer {
  let handshaken = false;
  const one = async (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(id, -32600, "Invalid Request");
    if (!jsonRpcMethodContracts.some((entry) => entry.method === request.method)) return rpcError(id, -32601, "Method not found");
    const reply = (result: JsonObject): JsonRpcResponse | undefined => request.id === undefined ? undefined : { jsonrpc: "2.0", id, result };
    const parsed = parseDaemonRpcParams(request.method, request.params);
    if (!parsed.ok) return reply(failure(request.method, "invalid_request", parsed.errors.join("; ")));
    const params = parsed.params;
    if (request.method === "protocol.hello") {
      if (params.protocolVersion !== currentDaemonProtocolVersion) return reply(failure("protocol.hello", "incompatible_protocol_version", "Use the daemon protocol version reported by this binary."));
      handshaken = true; return reply({ ok: true, protocolVersion: currentDaemonProtocolVersion, methods: jsonRpcMethodContracts.map((entry) => entry.method) });
    }
    if (!handshaken) return reply(failure(request.method, "hello_required", "Call protocol.hello first."));
    if (request.method === "daemon.status") return reply({ ok: true, ...options.host.status() } as unknown as JsonObject);
    if (request.method === "daemon.repo.bootstrap") {
      try { return reply(await options.host.bootstrap(params as unknown as { rootDir: string; repoId: string; personId: string; displayName: string }, options.authContext) as JsonObject); }
      catch (error) { return reply(failure("init", rpcServerErrorCode(error), error instanceof Error ? error.message : String(error))); }
    }
    if (request.method === "daemon.repo.register" || request.method === "daemon.repo.unregister") {
      try { return reply(await options.host.admin(request.method.endsWith("unregister") ? { kind: "unregister", repoId: params.repoId as string } : { kind: "register", repoId: params.repoId as string, rootDir: params.rootDir as string }, options.authContext) as JsonObject); }
      catch (error) { return reply(failure(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error))); }
    }
    if (isDaemonGuiReadMethod(request.method)) { const repo = (params.repo as JsonObject).repoId as string;
      try { return reply(await options.host.read(repo, request.method, options.authContext) as unknown as JsonObject); }
      catch (error) { return reply(failure(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error))); } }
    const repo = (params.repo as JsonObject).repoId as string, action = (params.payload as JsonObject).action as JsonObject;
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
  outcome: "rejected", opId: "N/A", origin: "daemon", code: errorCode, evidence: `rejection:${errorCode}`, error: { code: errorCode, hint: nextAction }, nextAction }; }
function rpcServerErrorCode(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "bootstrap_failed"; }
