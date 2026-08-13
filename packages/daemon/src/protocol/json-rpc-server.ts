import type { DaemonHost } from "../daemon-host.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { actionForDaemonMethod, daemonGuiStreamFacets, daemonProtocolError, isDaemonGuiReadMethod, isDaemonGuiStreamMethod, jsonRpcMethodContracts, parseDaemonRpcParams } from "./daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult, parseDaemonGuiStreamResult } from "./gui-result-validation.ts";
import { type JsonObject, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse } from "./json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./version.ts";
export interface JsonRpcProtocolServer { readonly handle: (message: JsonRpcRequest | JsonRpcRequest[]) => Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>; readonly close: () => void }
export function createJsonRpcProtocolServer(options: { readonly host: DaemonHost; readonly authContext: DaemonAuthenticationContext; readonly emit: (method: string, params: JsonObject) => Promise<void> }): JsonRpcProtocolServer {
  let handshaken = false;
  const subscriptions = new Set<Awaited<ReturnType<DaemonHost["attach"]>>>();
  const one = async (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(id, -32600, "Invalid Request");
    if (!jsonRpcMethodContracts.some((entry) => entry.method === request.method)) return rpcError(id, -32601, "Method not found");
    const reply = (result: JsonObject): JsonRpcResponse | undefined => request.id === undefined ? undefined : { jsonrpc: "2.0", id, result };
    const parsed = parseDaemonRpcParams(request.method, request.params);
    if (!parsed.ok) return reply(daemonProtocolError(request.method, "invalid_request", parsed.errors.join("; ")) as unknown as JsonObject);
    const params = parsed.params;
    if (request.method === "protocol.hello") {
      if (params.protocolVersion !== currentDaemonProtocolVersion) return reply(daemonProtocolError("protocol.hello", "incompatible_protocol_version", "Use the daemon protocol version reported by this binary.") as unknown as JsonObject);
      handshaken = true; return reply({ ok: true, protocolVersion: currentDaemonProtocolVersion, methods: jsonRpcMethodContracts.map((entry) => entry.method) });
    }
    if (!handshaken) return reply(daemonProtocolError(request.method, "hello_required", "Call protocol.hello first.") as unknown as JsonObject);
    if (request.method === "daemon.status") return reply({ ok: true, ...options.host.status() } as unknown as JsonObject);
    if (request.method === "daemon.repo.bootstrap") {
      try { return reply(await options.host.bootstrap(params as unknown as { rootDir: string; repoId: string; personId: string; displayName: string; name?: string }, options.authContext) as JsonObject); }
      catch (error) { return reply(daemonProtocolError("init", rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); }
    }
    if (request.method === "daemon.repo.register" || request.method === "daemon.repo.unregister") {
      try { return reply(await options.host.admin(request.method.endsWith("unregister") ? { kind: "unregister", repoId: params.repoId as string } : { kind: "register", repoId: params.repoId as string, rootDir: params.rootDir as string }, options.authContext) as JsonObject); }
      catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); }
    }
    if (isDaemonGuiStreamMethod(request.method)) { const repo = (params.repo as JsonObject).repoId as string, payload = params.payload as JsonObject;
      try { const subscription = await options.host.attach(repo, payload.runtimeSessionId as string, payload.afterCursor as string, options.authContext), initial = parseDaemonGuiStreamResult(request.method, subscription.initial); if (initial.ok) { subscriptions.add(subscription); setImmediate(() => pump(subscription)); } return reply(initial as unknown as JsonObject); }
      catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    if (isDaemonGuiReadMethod(request.method)) { const repo = (params.repo as JsonObject).repoId as string;
      try { return reply(parseDaemonGuiReadResult(request.method, await options.host.read(repo, request.method, params.payload as JsonObject | undefined ?? {}, options.authContext)) as unknown as JsonObject); }
      catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    const repo = (params.repo as JsonObject).repoId as string; let action: JsonObject & { readonly kind: string }; try { action = actionForDaemonMethod(request.method, params.payload as JsonObject); } catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); }
    if (action.kind === "preset-run-start" || action.kind === "preset-run-status") return reply(await options.host.presetRun(repo, action, options.authContext) as unknown as JsonObject);
    const receipt = await options.host.run(repo, action, options.authContext);
    const ok = receipt.outcome === "applied" || receipt.outcome === "pending";
    return reply({ schema: "command-receipt/v2", ok, command: action.kind, ...receipt,
      ...(!ok ? { error: { code: receipt.code ?? "write_rejected", hint: receipt.nextAction ?? "Inspect the rejection." } } : {}) } as unknown as JsonObject);
  };
  return { handle: async (message) => Array.isArray(message)
    ? (await Promise.all(message.map(one))).filter((item): item is JsonRpcResponse => item !== undefined) : one(message), close: () => { for (const subscription of subscriptions) subscription.detach(); subscriptions.clear(); } };
  async function pump(subscription: Awaited<ReturnType<DaemonHost["attach"]>>): Promise<void> { try { for (;;) { const event = await subscription.next(); if (!event) break; await options.emit(daemonGuiStreamFacets[0].eventMethod, event as unknown as JsonObject); } } finally { subscription.detach(); subscriptions.delete(subscription); } }
}
function rpcError(id: JsonRpcId, errorCode: number, message: string): JsonRpcResponse { return { jsonrpc: "2.0", id, error: { code: errorCode, message } }; }
function rpcServerErrorCode(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "bootstrap_failed"; }
