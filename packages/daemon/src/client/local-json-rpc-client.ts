import net from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
import type { JsonObject, JsonRpcRequest, JsonRpcResponse } from "../protocol/json-rpc-types.ts";
import { resolveLocalDaemonTarget, type LocalDaemonTarget } from "./local-daemon-target.ts";
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

export async function requestLocalDaemonJsonRpcForTarget(target: LocalDaemonTarget, method: string, params: JsonObject,
  timeoutMs = 75): Promise<JsonObject> {
  return requestDaemonJsonRpcAt(target.socketPath, method, params, timeoutMs);
}

export async function requestDaemonJsonRpcAt(socketPath: string, method: string, params: JsonObject, timeoutMs = 75): Promise<JsonObject> {
  return requestWithSocket(await connectSocket(socketPath, timeoutMs), method, params);
}

export class JsonRpcLineClient {
  private nextId = 1;
  private readonly input: Readable;
  private readonly output: Writable;
  constructor(input: Readable, output: Writable) { this.input = input; this.output = output; }
  async request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++, responsePromise = this.readResponse(id);
    this.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest)}\n`);
    const response = await responsePromise;
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

async function requestWithSocket(socket: net.Socket, method: string, params: JsonObject): Promise<JsonObject> {
  const client = new JsonRpcLineClient(socket, socket);
  try { await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }); return await client.request(method, params); }
  finally { client.close(); }
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath), timer = setTimeout(() => { socket.destroy(); reject(new Error("daemon_unavailable")); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
function jsonRpcRecord(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
