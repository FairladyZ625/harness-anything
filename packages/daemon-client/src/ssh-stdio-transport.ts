import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { JsonRpcConnection, PersistentTransport } from "./transport.ts";

export interface SshStdioTransportOptions {
  readonly host: string;
  readonly remoteHaPath?: string;
  readonly spawnProcess?: (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnOptionsWithoutStdio & { readonly stdio: readonly ["pipe", "pipe", "pipe"] }
  ) => ChildProcessWithoutNullStreams;
}

/** JSON-RPC lines over `ssh <host> ha daemon connect --stdio`. */
export class SshStdioTransport implements PersistentTransport {
  readonly #options: SshStdioTransportOptions;

  constructor(options: SshStdioTransportOptions) {
    if (!options.host) throw new Error("SSH stdio transport requires a host alias.");
    this.#options = options;
  }

  async open(_endpoint: string, signal?: AbortSignal): Promise<JsonRpcConnection> {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const child = (this.#options.spawnProcess ?? spawn)(
      "ssh",
      sshStdioArgs(this.#options.host, this.#options.remoteHaPath),
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    await waitForSpawn(child, signal);
    return jsonLineProcessConnection(child);
  }
}

export function sshStdioArgs(host: string, remoteHaPath = "ha"): ReadonlyArray<string> {
  return [host, remoteHaPath, "daemon", "connect", "--stdio"];
}

function jsonLineProcessConnection(child: ChildProcessWithoutNullStreams): JsonRpcConnection {
  const frameListeners = new Set<(frame: unknown) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closed = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string | Buffer) => {
    stdoutBuffer += chunk.toString();
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const frame: unknown = JSON.parse(line);
        for (const listener of frameListeners) listener(frame);
      } catch (error) {
        child.kill("SIGTERM");
        notifyClose(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  child.stderr.on("data", (chunk: string | Buffer) => {
    stderrBuffer = `${stderrBuffer}${chunk.toString()}`.slice(-4_096);
  });
  child.once("error", notifyClose);
  child.once("exit", (code, signal) => {
    const diagnostic = stderrBuffer.trim();
    const error = code === 0 || (code === null && signal === "SIGTERM")
      ? undefined
      : new Error(`SSH stdio transport exited (${code ?? signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`);
    notifyClose(error);
  });

  return {
    write: (frame) => {
      if (closed || child.stdin.destroyed) throw new Error("SSH stdio transport is closed.");
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    onFrame: (listener) => subscribe(frameListeners, listener),
    onClose: (listener) => subscribe(closeListeners, listener),
    close: async () => {
      if (closed) return;
      child.stdin.end();
      child.kill("SIGTERM");
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  };

  function notifyClose(error?: Error): void {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(error);
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      child.kill("SIGTERM");
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    const spawned = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      child.off("spawn", spawned);
      child.off("error", failed);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

function subscribe<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
