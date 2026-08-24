import net from "node:net";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
import type { DaemonSessionEnvironment } from "../protocol/daemon-protocol.contract.ts";
import type { JsonObject, JsonRpcRequest, JsonRpcResponse } from "../protocol/json-rpc-types.ts";
import { resolveLocalDaemonTarget } from "./local-daemon-target.ts";
export {
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint,
  resolveLocalDaemonTarget,
  type LocalDaemonTarget,
} from "./local-daemon-target.ts";

export interface LocalDaemonJsonRpcOptions {
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly socketPath?: string;
  readonly repoIdOverride?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionEnvironment?: DaemonSessionEnvironment;
}

export async function requestLocalDaemonJsonRpc(
  rootDir: string,
  method: string,
  params: JsonObject,
  timeoutMs = 75,
  options: LocalDaemonJsonRpcOptions = {},
): Promise<JsonObject> {
  const target = resolveLocalDaemonTarget({
    rootDir,
    repoIdOverride: options.repoIdOverride,
    userRoot: options.userRoot,
    daemonId: options.daemonId,
    env: options.env,
  });
  const socketPath = options.socketPath ?? target.socketPath;
  return requestWithSocket(
    await connectSocket(socketPath, timeoutMs),
    method,
    params,
    undefined,
    options.sessionEnvironment,
  );
}

export async function requestLocalDaemonJsonRpcForTarget(
  target: {
    readonly socketPath: string;
    readonly repoId?: string;
    readonly canonicalRoot?: string;
    readonly userRoot?: string;
    readonly daemonId?: string;
    readonly sessionEnvironment?: DaemonSessionEnvironment;
  },
  method: string,
  params: JsonObject,
  timeoutMs = 75,
  responseTimeoutMs?: number,
): Promise<JsonObject> {
  return requestDaemonJsonRpcAt(
    target.socketPath,
    method,
    params,
    timeoutMs,
    responseTimeoutMs,
    target.sessionEnvironment,
  );
}

export async function requestDaemonJsonRpcAt(
  socketPath: string,
  method: string,
  params: JsonObject,
  timeoutMs = 75,
  responseTimeoutMs?: number,
  sessionEnvironment?: DaemonSessionEnvironment,
): Promise<JsonObject> {
  return requestWithSocket(
    await connectSocket(socketPath, timeoutMs),
    method,
    params,
    responseTimeoutMs,
    sessionEnvironment,
  );
}

// One line reader per client, not per request. A readline interface attaches its own data/end/error
// listeners to the input, so a fresh interface per request stacked one listener set per request on a
// reused connection and nothing detached them: the read loop abandoned its iterator at the matching
// id, and readline only removes those listeners at interface close. A long `--wait` over one
// persistent socket (the #1721 reader) crossed the 10-listener warning by round ten, and every
// abandoned iterator kept parsing and retaining each later line, which is unbounded memory. The
// single reader keeps the listener count constant for any number of requests on the connection;
// lines whose id no waiter will ever await again (a response that outlived its response deadline)
// are dropped, matching the old scan-past semantics.
interface ResponseWaiter {
  readonly id: number;
  readonly resolve: (response: JsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
}
// Local twin of the kernel's consumeKnownError (packages/cli/src/daemon/client.ts and
// packages/gui/src/api each keep their own too). The kernel symbol is only importable through
// its public barrel, and one barrel import here loaded the whole kernel (with its effect
// dependency, ~250ms) on every CLI→daemon command's critical path — the PR #1726 write-path
// regression. The call itself is a lint contract (ha/no-swallowed-failure), so the marker stays;
// only its dependency moves.
function consumeKnownError(error: unknown): void {
  void error;
}
export class JsonRpcLineClient {
  private nextId = 1;
  private readonly output: Writable;
  private readonly lines: ReadlineInterface;
  private readonly waiters: ResponseWaiter[] = [];
  private closed = false;
  constructor(input: Readable, output: Writable) {
    this.output = output;
    this.lines = createInterface({ input });
    this.lines.on("line", (line) => this.onLine(line));
    this.lines.on("close", () => this.onClosed());
  }
  async request(method: string, params: JsonObject, responseTimeoutMs?: number): Promise<JsonObject> {
    const id = this.nextId++,
      responsePromise = this.readResponse(id);
    this.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest)}\n`);
    const response =
      responseTimeoutMs === undefined
        ? await responsePromise
        : await Promise.race([responsePromise, responseDeadline(method, responseTimeoutMs)]);
    if ("error" in response) throw new Error(response.error.message);
    if (!jsonRpcRecord(response.result)) throw new Error(`daemon returned non-object result for ${method}`);
    return response.result;
  }
  close(): void {
    this.output.end();
    this.lines.close();
  }
  private readResponse(id: number): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (this.closed) reject(new Error(`daemon closed before JSON-RPC response ${id}`));
      else this.waiters.push({ id, resolve, reject });
    });
  }
  private onLine(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch (error) {
      consumeKnownError(error);
      this.waiters
        .shift()
        ?.reject(
          new Error(`daemon sent a malformed JSON-RPC line: ${error instanceof Error ? error.message : String(error)}`),
        );
      return;
    }
    const index = this.waiters.findIndex((waiter) => waiter.id === response.id);
    if (index < 0) return;
    const [waiter] = this.waiters.splice(index, 1);
    waiter.resolve(response);
  }
  private onClosed(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new Error(`daemon closed before JSON-RPC response ${waiter.id}`));
  }
}

async function requestWithSocket(
  socket: net.Socket,
  method: string,
  params: JsonObject,
  responseTimeoutMs?: number,
  sessionEnvironment?: DaemonSessionEnvironment,
): Promise<JsonObject> {
  const client = new JsonRpcLineClient(socket, socket);
  try {
    await client.request(
      "protocol.hello",
      {
        protocolVersion: currentDaemonProtocolVersion,
        ...(sessionEnvironment && Object.keys(sessionEnvironment).length > 0
          ? { sessionEnvironment: sessionEnvironment as JsonObject }
          : {}),
      },
      responseTimeoutMs,
    );
    return await client.request(method, params, responseTimeoutMs);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === "daemon_response_timeout"
    )
      socket.destroy();
    throw error;
  } finally {
    client.close();
  }
}
// A daemon that never answers leaves the caller with no output and no error, so a caller that knows its request is
// cheap can name a deadline and get a classified failure instead of an open-ended wait. The hint is forked by what
// the silent method actually was, but a deadline only proves one connection went unanswered — never which side
// stalled: the deadline clock lives in the caller, so a starved or degraded caller process misses it exactly like a
// wedged daemon does. A silent protocol.hello still cannot be a held workspace write (it precedes every command),
// so the hello hint names both sides and how to tell them apart instead of asserting the daemon never started.
function responseDeadline(method: string, responseTimeoutMs: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(
      () =>
        reject(
          Object.assign(new Error(responseTimeoutHint(method, responseTimeoutMs)), { code: "daemon_response_timeout" }),
        ),
      responseTimeoutMs,
    ).unref();
  });
}
function responseTimeoutHint(method: string, responseTimeoutMs: number): string {
  const waited = `${responseTimeoutMs / 1_000}s`;
  if (method === "protocol.hello")
    return `the daemon did not answer ${method} within ${waited}; it accepted the connection, but the deadline clock lives in this caller, so check ha daemon status before blaming the daemon — a healthy answer means this client stalled its own side, and no answer means it is still starting (repository attach) or wedged during startup. This is not a long write.`;
  return `the daemon did not answer ${method} within ${waited}; a long write may be holding the workspace queue, or the daemon wedged during startup. Run ha daemon status, wait for it to finish, then retry.`;
}

export function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath),
      timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("daemon_unavailable"));
      }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
export function jsonRpcRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
