import net from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
import type { JsonObject, JsonRpcRequest, JsonRpcResponse } from "../protocol/json-rpc-types.ts";
import { resolveLocalDaemonTarget } from "./local-daemon-target.ts";
export { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, resolveLocalDaemonTarget, type LocalDaemonTarget } from "./local-daemon-target.ts";

export interface LocalDaemonJsonRpcOptions {
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly socketPath?: string;
  readonly repoIdOverride?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function requestLocalDaemonJsonRpc(rootDir: string, method: string, params: JsonObject, timeoutMs = 75,
  options: LocalDaemonJsonRpcOptions = {}): Promise<JsonObject> {
  const target = resolveLocalDaemonTarget({ rootDir, repoIdOverride: options.repoIdOverride, userRoot: options.userRoot,
    daemonId: options.daemonId, env: options.env });
  const socketPath = options.socketPath ?? target.socketPath;
  return requestWithSocket(await connectSocket(socketPath, timeoutMs), method, params);
}

export async function requestLocalDaemonJsonRpcForTarget(target: { readonly socketPath: string; readonly repoId?: string; readonly canonicalRoot?: string;
  readonly userRoot?: string; readonly daemonId?: string }, method: string, params: JsonObject,
  timeoutMs = 75, responseTimeoutMs?: number): Promise<JsonObject> {
  return requestDaemonJsonRpcAt(target.socketPath, method, params, timeoutMs, responseTimeoutMs);
}

export async function requestDaemonJsonRpcAt(socketPath: string, method: string, params: JsonObject, timeoutMs = 75, responseTimeoutMs?: number): Promise<JsonObject> {
  return requestWithSocket(await connectSocket(socketPath, timeoutMs), method, params, responseTimeoutMs);
}

export async function requestDaemonShutdownAt(socketPath: string, timeoutMs = 75): Promise<void> {
  const socket = await connectSocket(socketPath, timeoutMs);
  const payload = [
    { jsonrpc: "2.0", method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } } satisfies JsonRpcRequest,
    { jsonrpc: "2.0", method: "daemon.stop", params: {} } satisfies JsonRpcRequest
  ].map((request) => JSON.stringify(request)).join("\n") + "\n";
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    socket.once("error", fail);
    socket.end(payload, () => { socket.off("error", fail); resolve(); });
  });
}

export class JsonRpcLineClient {
  private nextId = 1;
  private readonly input: Readable;
  private readonly output: Writable;
  constructor(input: Readable, output: Writable) { this.input = input; this.output = output; }
  async request(method: string, params: JsonObject, responseTimeoutMs?: number): Promise<JsonObject> {
    const id = this.nextId++, responsePromise = this.readResponse(id);
    this.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest)}\n`);
    const response = responseTimeoutMs === undefined ? await responsePromise : await Promise.race([responsePromise, responseDeadline(method, responseTimeoutMs)]);
    if ("error" in response) throw new Error(response.error.message);
    if (!jsonRpcRecord(response.result)) throw new Error(`daemon returned non-object result for ${method}`);
    return response.result;
  }
  close(): void { this.output.end(); }
  private async readResponse(id: number): Promise<JsonRpcResponse> {
    const iterator = createInterface({ input: this.input })[Symbol.asyncIterator]();
    for (;;) { const next = await iterator.next(); if (next.done) throw new Error(`daemon closed before JSON-RPC response ${id}`);
      const response = JSON.parse(next.value) as JsonRpcResponse; if (response.id === id) return response; }
  }
}

async function requestWithSocket(socket: net.Socket, method: string, params: JsonObject, responseTimeoutMs?: number): Promise<JsonObject> {
  const client = new JsonRpcLineClient(socket, socket);
  try { await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, responseTimeoutMs); return await client.request(method, params, responseTimeoutMs); }
  catch (error) { if (typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === "daemon_response_timeout") socket.destroy(); throw error; }
  finally { client.close(); }
}
// A daemon that never answers leaves the caller with no output and no error, so a caller that knows its request is
// cheap can name a deadline and get a classified failure instead of an open-ended wait.
function responseDeadline(method: string, responseTimeoutMs: number): Promise<never> {
  return new Promise((_resolve, reject) => { setTimeout(() => reject(Object.assign(new Error(`the daemon did not answer ${method} within ${responseTimeoutMs / 1_000}s; a long write is holding the workspace queue. Run ha daemon status, wait for it to finish, then retry.`), { code: "daemon_response_timeout" })), responseTimeoutMs).unref(); });
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath), timer = setTimeout(() => { socket.destroy(); reject(new Error("daemon_unavailable")); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
function jsonRpcRecord(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
