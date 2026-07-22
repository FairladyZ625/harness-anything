import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonObject, JsonRpcRequest, JsonRpcResponse } from "../protocol/json-rpc-types.ts";
import { encodeJsonLineFrame } from "../transport/frame-codec.ts";

export const defaultDaemonJsonRpcRequestTimeoutMs = 35_000;

export class DaemonJsonRpcResponseError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "DaemonJsonRpcResponseError";
    this.code = code;
  }
}

export class DaemonJsonRpcRequestTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`DAEMON_JSON_RPC_REQUEST_TIMEOUT:method=${method};timeout=${timeoutMs}ms`);
    this.name = "DaemonJsonRpcRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class JsonRpcLineClient {
  private nextId = 1;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly owner?: ChildProcessWithoutNullStreams;

  constructor(input: Readable, output: Writable, owner?: ChildProcessWithoutNullStreams) {
    this.input = input;
    this.output = output;
    this.owner = owner;
  }

  async request(
    method: string,
    params: JsonObject,
    timeoutMs = defaultDaemonJsonRpcRequestTimeoutMs
  ): Promise<JsonObject> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("daemon JSON-RPC request timeout must be a positive integer");
    }
    const id = this.nextId++;
    const responsePromise = this.readResponse(id, method, timeoutMs);
    const request = { jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest;
    this.output.write(encodeJsonLineFrame(request));
    const response = await responsePromise;
    if ("error" in response) throw new DaemonJsonRpcResponseError(response.error.code, response.error.message);
    if (!isPlainRecord(response.result)) throw new Error(`daemon returned non-object result for ${method}`);
    return response.result as JsonObject;
  }

  close(): void {
    this.output.end();
    this.owner?.kill("SIGTERM");
  }

  private async readResponse(id: number, method: string, timeoutMs: number): Promise<JsonRpcResponse> {
    const lines = createInterface({ input: this.input });
    const iterator = lines[Symbol.asyncIterator]();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new DaemonJsonRpcRequestTimeoutError(method, timeoutMs));
        lines.close();
      }, timeoutMs);
    });
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), timeout]);
        if (next.done) throw new Error(`daemon closed before JSON-RPC response ${id}`);
        const response = JSON.parse(next.value) as JsonRpcResponse;
        if (response.id === id) return response;
      }
    } finally {
      if (timer) clearTimeout(timer);
      lines.close();
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
