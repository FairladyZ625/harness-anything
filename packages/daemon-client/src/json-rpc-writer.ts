import type { JsonRpcConnection } from "./transport.ts";

export class DaemonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "DaemonRpcError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

export class JsonRpcWriter {
  readonly #connection: JsonRpcConnection;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;

  constructor(connection: JsonRpcConnection) {
    this.#connection = connection;
  }

  request(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs: number }): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#reject(id, new Error(`daemon request timed out: ${method}`)), options.timeoutMs);
      const abort = () => this.#reject(id, abortError());
      options.signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        }
      });
      this.#connection.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#connection.write({ jsonrpc: "2.0", method, params });
  }

  accept(frame: unknown): "response" | "other" {
    if (!isJsonRpcRecord(frame) || (typeof frame.id !== "number" && typeof frame.id !== "string")) return "other";
    if (typeof frame.id !== "number") throw new Error(`unknown daemon response id ${String(frame.id)}`);
    const pending = this.#pending.get(frame.id);
    if (!pending) throw new Error(`unknown daemon response id ${frame.id}`);
    this.#pending.delete(frame.id);
    pending.cleanup();
    if (isJsonRpcRecord(frame.error)) {
      pending.reject(new DaemonRpcError(
        typeof frame.error.code === "number" ? frame.error.code : -32603,
        typeof frame.error.message === "string" ? frame.error.message : "daemon request failed",
        frame.error.data
      ));
    } else {
      pending.resolve(frame.result);
    }
    return "response";
  }

  disconnect(error = new Error("daemon connection closed")): void {
    for (const [id] of this.#pending) this.#reject(id, error);
  }

  pendingCount(): number {
    return this.#pending.size;
  }

  #reject(id: number, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.cleanup();
    pending.reject(error);
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function isJsonRpcRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
