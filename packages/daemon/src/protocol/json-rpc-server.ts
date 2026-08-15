import type { DaemonHost } from "../daemon-host.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { actionForDaemonMethod, daemonGuiStreamFacets, daemonProtocolError, isDaemonGuiActionMethod, isDaemonGuiReadMethod, isDaemonGuiStreamMethod, jsonRpcMethodContracts, parseDaemonRpcParams } from "./daemon-protocol.contract.ts";
import { parseDaemonGuiActionResult, parseDaemonGuiReadResult, parseDaemonGuiStreamResult } from "./gui-result-validation.ts";
import { type JsonObject, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse } from "./json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./version.ts";
export interface JsonRpcProtocolServer { readonly handle: (message: JsonRpcRequest | JsonRpcRequest[]) => Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>; readonly close: () => void }
export function createJsonRpcProtocolServer(options: { readonly host: DaemonHost; readonly authContext: DaemonAuthenticationContext; readonly emit: (method: string, params: JsonObject) => Promise<void> }): JsonRpcProtocolServer {
  let handshaken = false;
  type Subscription = { readonly initial: unknown; readonly next: () => Promise<JsonObject | null>; readonly detach: () => void }; const subscriptions = new Set<Subscription>();
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
      try { return reply(await options.host.bootstrap(params as unknown as { rootDir: string; repoId: string; personId: string; displayName: string; name?: string; addNpmScripts?: boolean }, options.authContext) as JsonObject); }
      catch (error) { return reply(daemonProtocolError("init", rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); }
    }
    if (request.method === "daemon.repo.register" || request.method === "daemon.repo.unregister") {
      try { return reply(await options.host.admin(request.method.endsWith("unregister") ? { kind: "unregister", repoId: params.repoId as string } : { kind: "register", repoId: params.repoId as string, rootDir: params.rootDir as string }, options.authContext) as JsonObject); }
      catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); }
    }
    if (request.method.startsWith("daemon.runtimeInstance.")) { try { return reply(options.host.runtimeInstance(request.method, params.payload as JsonObject, options.authContext)); } catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    if (request.method.startsWith("repo.runtimeInstance.auth.")) { const repo = (params.repo as JsonObject).repoId as string; try { return reply(await options.host.runtimeInstanceAuth(repo, request.method, params.payload as JsonObject, options.authContext)); } catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    if (request.method === "daemon.gui.system.read") { try { return reply(parseDaemonGuiReadResult(request.method, options.host.system(options.authContext)) as unknown as JsonObject); } catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    if (request.method === "daemon.gui.control.receipt") { try { return reply(parseDaemonGuiReadResult(request.method, options.host.controlReceipt(String((params.payload as JsonObject).operationId), options.authContext)) as unknown as JsonObject); } catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    if (request.method === "daemon.gui.control.request") { try { return reply(parseDaemonGuiActionResult(request.method, await options.host.requestControl(params.payload as JsonObject, options.authContext)) as unknown as JsonObject); } catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    if (isDaemonGuiStreamMethod(request.method)) { const repo = (params.repo as JsonObject).repoId as string, payload = params.payload as JsonObject;
      try { const subscription: Subscription = request.method === "repo.agentRuntime.attach" ? await options.host.attach(repo, payload.runtimeSessionId as string, payload.afterCursor as string, options.authContext) : await options.host.terminalAttach(repo, payload.sessionId as string, payload.afterSeq as number, options.authContext), initial = parseDaemonGuiStreamResult(request.method, subscription.initial); if (initial.ok) { subscriptions.add(subscription); const eventMethod = daemonGuiStreamFacets.find((facet) => facet.method === request.method)!.eventMethod; setImmediate(() => pump(subscription, eventMethod)); } return reply(initial as unknown as JsonObject); }
      catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    if (isDaemonGuiReadMethod(request.method)) { const repo = (params.repo as JsonObject).repoId as string;
      try { return reply(parseDaemonGuiReadResult(request.method, await options.host.read(repo, request.method, params.payload as JsonObject | undefined ?? {}, options.authContext)) as unknown as JsonObject); }
      catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    if (request.method === "repo.agentRuntime.spawn") { const repo = (params.repo as JsonObject).repoId as string; try { return reply(parseDaemonGuiActionResult(request.method, await options.host.spawnRuntime(repo, params.payload as JsonObject, options.authContext)) as unknown as JsonObject); } catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    if (request.method === "repo.gui.catalog.reread" || request.method.startsWith("repo.terminal.")) { const repo = (params.repo as JsonObject).repoId as string; try { return reply(parseDaemonGuiActionResult(request.method as import("./daemon-protocol.contract.ts").DaemonGuiActionMethod, await options.host.terminalAction(repo, request.method, params.payload as JsonObject, options.authContext)) as unknown as JsonObject); } catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); } }
    const repo = (params.repo as JsonObject).repoId as string; let action: JsonObject & { readonly kind: string }; try { action = actionForDaemonMethod(request.method, params.payload as JsonObject); } catch (error) { return reply(daemonProtocolError(request.method, rpcServerErrorCode(error), error instanceof Error ? error.message : String(error)) as unknown as JsonObject); }
    if (action.kind === "preset-run-start" || action.kind === "preset-run-status") return reply(await options.host.presetRun(repo, action, options.authContext) as unknown as JsonObject);
    const receipt = await options.host.run(repo, action, options.authContext);
    const ok = receipt.outcome === "applied" || receipt.outcome === "pending";
    const result = { schema: "command-receipt/v2", ok, command: action.kind, ...receipt, ...(!ok ? { error: { code: receipt.code ?? "write_rejected", hint: receipt.nextAction ?? "Inspect the rejection." } } : {}) } as unknown as JsonObject;
    return reply(isDaemonGuiActionMethod(request.method) ? parseDaemonGuiActionResult(request.method, result) as unknown as JsonObject : result);
  };
  return { handle: async (message) => Array.isArray(message)
    ? (await Promise.all(message.map(one))).filter((item): item is JsonRpcResponse => item !== undefined) : one(message), close: () => { for (const subscription of subscriptions) subscription.detach(); subscriptions.clear(); } };
  async function pump(subscription: Subscription, eventMethod: string): Promise<void> { try { for (;;) { const event = await subscription.next(); if (!event) break; await options.emit(eventMethod, event); } } finally { subscription.detach(); subscriptions.delete(subscription); } }
}
function rpcError(id: JsonRpcId, errorCode: number, message: string): JsonRpcResponse { return { jsonrpc: "2.0", id, error: { code: errorCode, message } }; }
function rpcServerErrorCode(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "bootstrap_failed"; }
