import type { JsonRpcConnection, PersistentTransport } from "../src/transport.ts";

export interface RequestFrame {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

export class FakeConnection implements JsonRpcConnection {
  readonly writes: unknown[] = [];
  readonly #frames = new Set<(frame: unknown) => void>();
  readonly #closes = new Set<(error?: Error) => void>();
  readonly #handler: (request: RequestFrame, connection: FakeConnection) => void;
  closed = false;

  constructor(handler: (request: RequestFrame, connection: FakeConnection) => void) {
    this.#handler = handler;
  }

  write(frame: unknown): void {
    this.writes.push(frame);
    this.#handler(frame as RequestFrame, this);
  }

  onFrame(listener: (frame: unknown) => void): () => void {
    this.#frames.add(listener);
    return () => this.#frames.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  async close(): Promise<void> {
    this.disconnect();
  }

  respond(id: number, result: unknown): void {
    queueMicrotask(() => this.emit({ jsonrpc: "2.0", id, result }));
  }

  reject(id: number, message: string, data?: unknown): void {
    queueMicrotask(() => this.emit({ jsonrpc: "2.0", id, error: { code: -32010, message, data } }));
  }

  notify(repoId: string, seq: number, kind = "invalidate"): void {
    queueMicrotask(() => this.emit({ jsonrpc: "2.0", method: "repo.event", params: { repoId, seq, kind } }));
  }

  emit(frame: unknown): void {
    for (const listener of this.#frames) listener(frame);
  }

  disconnect(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.#closes) listener(error);
  }
}

export class FakeTransport implements PersistentTransport {
  readonly connections: FakeConnection[] = [];
  readonly #handler: (request: RequestFrame, connection: FakeConnection) => void;

  constructor(handler: (request: RequestFrame, connection: FakeConnection) => void) {
    this.#handler = handler;
  }

  async open(_endpoint: string, signal?: AbortSignal): Promise<JsonRpcConnection> {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const connection = new FakeConnection(this.#handler);
    this.connections.push(connection);
    return connection;
  }
}

export function hello(connection: FakeConnection, request: RequestFrame, notifications = true): boolean {
  if (request.method !== "protocol.hello") return false;
  connection.respond(request.id, {
    protocolVersion: 1,
    daemonId: "fixture",
    capabilities: { notifications, retentionGap: notifications }
  });
  return true;
}
