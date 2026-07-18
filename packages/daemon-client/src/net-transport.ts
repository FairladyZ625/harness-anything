// @slice-activation W-D2 persistent Node transport exported for W-D3 host composition.
import net from "node:net";
import type { JsonRpcConnection, PersistentTransport } from "./transport.ts";

export class JsonLineSocketTransport implements PersistentTransport {
  async open(endpoint: string, signal?: AbortSignal): Promise<JsonRpcConnection> {
    const socket = endpoint.startsWith("tcp://")
      ? net.createConnection(parseTcpEndpoint(endpoint))
      : net.createConnection(endpoint.replace(/^unix:/u, ""));
    socket.setEncoding("utf8");
    await waitForConnect(socket, signal);
    return jsonLineConnection(socket);
  }
}

function jsonLineConnection(socket: net.Socket): JsonRpcConnection {
  const frameListeners = new Set<(frame: unknown) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  let buffer = "";
  socket.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const frame: unknown = JSON.parse(line);
        for (const listener of frameListeners) listener(frame);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  socket.once("close", () => {
    for (const listener of closeListeners) listener();
  });
  socket.once("error", (error) => {
    for (const listener of closeListeners) listener(error);
  });
  return {
    write: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
    onFrame: (listener) => subscribe(frameListeners, listener),
    onClose: (listener) => subscribe(closeListeners, listener),
    close: async () => {
      if (socket.destroyed) return;
      socket.end();
      await new Promise<void>((resolve) => socket.once("close", resolve));
    }
  };
}

function waitForConnect(socket: net.Socket, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    socket.destroy();
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => socket.destroy(new DOMException("The operation was aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
    socket.once("error", reject);
  });
}

function parseTcpEndpoint(endpoint: string): { host: string; port: number } {
  const url = new URL(endpoint);
  return { host: url.hostname, port: Number(url.port) };
}

function subscribe<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
