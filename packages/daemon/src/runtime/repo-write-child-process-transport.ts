import {
  fork,
  type ChildProcess,
  type ForkOptions
} from "node:child_process";
import type { RepoWriteChildTransport } from "./repo-write-child-host.ts";
import type { RepoWriteClientTransport } from "./repo-write-client.ts";
import {
  parseRepoWriteChildMessage,
  parseRepoWriteParentMessage,
  stringifyRepoWriteChildMessage,
  stringifyRepoWriteParentMessage,
  type RepoWriteChildMessage,
  type RepoWriteParentMessage,
  type RepoWriteProtocolLimits
} from "./repo-write-protocol.ts";

export interface RepoWriteProcessTransportLimits {
  readonly maxBufferedMessages: number;
  readonly maxPendingSends: number;
}

export interface ForkRepoWriteProcessOptions {
  readonly modulePath: string | URL;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string | URL;
  readonly env?: NodeJS.ProcessEnv;
  readonly execArgv?: ReadonlyArray<string>;
  readonly silent?: boolean;
  readonly protocolLimits?: Partial<RepoWriteProtocolLimits>;
  readonly transportLimits?: Partial<RepoWriteProcessTransportLimits>;
  readonly forkProcess?: RepoWriteFork;
}

export type RepoWriteFork = (
  modulePath: string | URL,
  args: ReadonlyArray<string>,
  options: ForkOptions
) => ChildProcess;

export type RepoWriteDisconnectReason =
  "protocol" | "capacity" | "send" | "spawn" | "exit" | "signal" | "disconnect" | "listener";

export class RepoWriteProcessDisconnectError extends Error {
  readonly code = "REPO_WRITE_PROCESS_DISCONNECTED" as const;
  readonly reason: RepoWriteDisconnectReason;
  readonly exitCode: number | undefined;
  readonly signal: NodeJS.Signals | undefined;

  constructor(
    reason: RepoWriteDisconnectReason,
    message: string,
    details: { readonly exitCode?: number; readonly signal?: NodeJS.Signals; readonly cause?: unknown } = {}
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "RepoWriteProcessDisconnectError";
    this.reason = reason;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
  }
}

export class RepoWriteProcessCapacityError extends Error {
  readonly code = "REPO_WRITE_PROCESS_CAPACITY" as const;

  constructor(message: string) {
    super(message);
    this.name = "RepoWriteProcessCapacityError";
  }
}

const defaultTransportLimits: RepoWriteProcessTransportLimits = {
  maxBufferedMessages: 64,
  maxPendingSends: 256
};

/**
 * Fork exactly one per-repository writer process. Restart policy deliberately
 * belongs to the daemon supervisor, never to the transport.
 */
export function forkRepoWriteProcess(options: ForkRepoWriteProcessOptions): RepoWriteParentProcessTransport {
  const forkProcess = options.forkProcess ?? defaultFork;
  const child = forkProcess(options.modulePath, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    execArgv: options.execArgv ? [...options.execArgv] : undefined,
    silent: options.silent,
    serialization: "json"
  });
  return new RepoWriteParentProcessTransport(child, {
    protocolLimits: options.protocolLimits,
    transportLimits: options.transportLimits
  });
}

export class RepoWriteParentProcessTransport implements RepoWriteClientTransport {
  readonly child: ChildProcess;
  private readonly protocolLimits: Partial<RepoWriteProtocolLimits>;
  private readonly limits: RepoWriteProcessTransportLimits;
  private readonly messages = new Set<(message: RepoWriteChildMessage) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();
  private readonly buffered: RepoWriteChildMessage[] = [];
  private readonly pendingSendRejectors = new Set<(error: RepoWriteProcessDisconnectError) => void>();
  private pendingSends = 0;
  private terminalError: RepoWriteProcessDisconnectError | undefined;
  private pendingDisconnect: NodeJS.Timeout | undefined;

  constructor(
    child: ChildProcess,
    options: {
      readonly protocolLimits?: Partial<RepoWriteProtocolLimits>;
      readonly transportLimits?: Partial<RepoWriteProcessTransportLimits>;
    } = {}
  ) {
    this.child = child;
    this.protocolLimits = options.protocolLimits ?? {};
    this.limits = resolveTransportLimits(options.transportLimits);
    child.on("message", this.handleMessage);
    child.on("disconnect", this.handleIpcDisconnect);
    child.on("error", this.handleProcessError);
    child.on("exit", this.handleExit);
  }

  send(message: RepoWriteParentMessage): Promise<void> {
    let payload: object;
    try {
      payload = JSON.parse(stringifyRepoWriteParentMessage(message, this.protocolLimits)) as object;
    } catch (error) {
      return Promise.reject(error);
    }
    return this.sendPayload(payload);
  }

  onMessage(listener: (message: RepoWriteChildMessage) => void): () => void {
    if (this.terminalError) return () => undefined;
    this.messages.add(listener);
    if (this.messages.size === 1 && this.buffered.length > 0) {
      queueMicrotask(() => this.flushBuffered());
    }
    return () => this.messages.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    if (this.terminalError) {
      let active = true;
      queueMicrotask(() => {
        if (active) listener(this.terminalError!);
      });
      return () => {
        active = false;
      };
    }
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }

  terminate(signal: NodeJS.Signals = "SIGTERM"): boolean {
    return this.child.kill(signal);
  }

  private readonly handleMessage = (value: unknown): void => {
    if (this.terminalError) return;
    let message: RepoWriteChildMessage;
    try {
      message = parseRepoWriteChildMessage(jsonText(value), this.protocolLimits);
    } catch (error) {
      this.fail(new RepoWriteProcessDisconnectError(
        "protocol",
        "Repo writer child sent a malformed or over-limit IPC frame.",
        { cause: error }
      ), true);
      return;
    }
    if (this.messages.size === 0) {
      if (this.buffered.length >= this.limits.maxBufferedMessages) {
        this.fail(new RepoWriteProcessDisconnectError(
          "capacity",
          "Repo writer child exceeded the bounded pre-listener message buffer."
        ), true);
        return;
      }
      this.buffered.push(message);
      return;
    }
    this.publish(message);
  };

  private readonly handleIpcDisconnect = (): void => {
    if (this.terminalError || this.pendingDisconnect) return;
    // Node commonly emits `disconnect` just before `exit`. A short coalescing
    // window preserves the more useful exit-code/signal diagnosis.
    this.pendingDisconnect = setTimeout(() => {
      this.pendingDisconnect = undefined;
      this.fail(new RepoWriteProcessDisconnectError(
        "disconnect",
        "Repo writer child IPC channel disconnected."
      ));
    }, 25);
  };

  private readonly handleProcessError = (error: Error): void => {
    this.fail(new RepoWriteProcessDisconnectError(
      "spawn",
      `Repo writer child process failed: ${error.message}`,
      { cause: error }
    ));
  };

  private readonly handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (signal) {
      this.fail(new RepoWriteProcessDisconnectError(
        "signal",
        `Repo writer child exited from signal ${signal}.`,
        { signal }
      ));
      return;
    }
    this.fail(new RepoWriteProcessDisconnectError(
      "exit",
      `Repo writer child exited with code ${code ?? "unknown"}.`,
      { ...(code === null ? {} : { exitCode: code }) }
    ));
  };

  private sendPayload(payload: object): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (!this.child.connected) {
      const error = new RepoWriteProcessDisconnectError(
        "disconnect",
        "Repo writer child IPC channel is not connected."
      );
      this.fail(error);
      return Promise.reject(error);
    }
    if (this.pendingSends >= this.limits.maxPendingSends) {
      return Promise.reject(new RepoWriteProcessCapacityError(
        "Repo writer parent exceeded the bounded pending-send limit."
      ));
    }
    this.pendingSends += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: RepoWriteProcessDisconnectError) => {
        if (settled) return;
        settled = true;
        this.pendingSendRejectors.delete(abort);
        this.pendingSends -= 1;
        if (error) reject(error);
        else resolve();
      };
      const abort = (error: RepoWriteProcessDisconnectError) => settle(error);
      this.pendingSendRejectors.add(abort);
      try {
        this.child.send(payload, (error) => {
          if (!error) {
            settle();
            return;
          }
          const disconnect = new RepoWriteProcessDisconnectError(
            "send",
            `Repo writer parent IPC send failed: ${error.message}`,
            { cause: error }
          );
          this.fail(disconnect);
        });
      } catch (error) {
        const disconnect = new RepoWriteProcessDisconnectError(
          "send",
          "Repo writer parent IPC send threw before completion.",
          { cause: error }
        );
        this.fail(disconnect);
      }
    });
  }

  private flushBuffered(): void {
    while (!this.terminalError && this.messages.size > 0 && this.buffered.length > 0) {
      this.publish(this.buffered.shift()!);
    }
  }

  private publish(message: RepoWriteChildMessage): void {
    try {
      for (const listener of this.messages) listener(message);
    } catch (error) {
      this.fail(new RepoWriteProcessDisconnectError(
        "listener",
        "Repo writer parent message listener failed.",
        { cause: error }
      ), true);
    }
  }

  private fail(error: RepoWriteProcessDisconnectError, terminate = false): void {
    if (this.terminalError) return;
    this.terminalError = error;
    if (this.pendingDisconnect) clearTimeout(this.pendingDisconnect);
    this.pendingDisconnect = undefined;
    this.buffered.length = 0;
    this.removeProcessListeners();
    for (const reject of [...this.pendingSendRejectors]) reject(error);
    if (terminate && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
    for (const listener of this.disconnects) listener(error);
    this.disconnects.clear();
    this.messages.clear();
  }

  private removeProcessListeners(): void {
    this.child.off("message", this.handleMessage);
    this.child.off("disconnect", this.handleIpcDisconnect);
    this.child.off("error", this.handleProcessError);
    this.child.off("exit", this.handleExit);
  }
}

export class RepoWriteChildIpcTransport implements RepoWriteChildTransport {
  private readonly endpoint: NodeJS.Process;
  private readonly protocolLimits: Partial<RepoWriteProtocolLimits>;
  private readonly limits: RepoWriteProcessTransportLimits;
  private readonly messages = new Set<(message: RepoWriteParentMessage) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();
  private readonly buffered: RepoWriteParentMessage[] = [];
  private readonly pendingSendRejectors = new Set<(error: RepoWriteProcessDisconnectError) => void>();
  private pendingSends = 0;
  private terminalError: RepoWriteProcessDisconnectError | undefined;

  constructor(
    endpoint: NodeJS.Process = process,
    options: {
      readonly protocolLimits?: Partial<RepoWriteProtocolLimits>;
      readonly transportLimits?: Partial<RepoWriteProcessTransportLimits>;
    } = {}
  ) {
    if (!endpoint.send || endpoint.connected !== true) {
      throw new Error("Repo writer child IPC transport requires a connected Node IPC channel.");
    }
    this.endpoint = endpoint;
    this.protocolLimits = options.protocolLimits ?? {};
    this.limits = resolveTransportLimits(options.transportLimits);
    endpoint.on("message", this.handleMessage);
    endpoint.on("disconnect", this.handleDisconnect);
  }

  send(message: RepoWriteChildMessage): Promise<void> {
    let payload: object;
    try {
      payload = JSON.parse(stringifyRepoWriteChildMessage(message, this.protocolLimits)) as object;
    } catch (error) {
      return Promise.reject(error);
    }
    return this.sendPayload(payload);
  }

  onMessage(listener: (message: RepoWriteParentMessage) => void): () => void {
    if (this.terminalError) return () => undefined;
    this.messages.add(listener);
    if (this.messages.size === 1 && this.buffered.length > 0) {
      queueMicrotask(() => this.flushBuffered());
    }
    return () => this.messages.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    if (this.terminalError) {
      let active = true;
      queueMicrotask(() => {
        if (active) listener(this.terminalError!);
      });
      return () => {
        active = false;
      };
    }
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }

  private readonly handleMessage = (value: unknown): void => {
    if (this.terminalError) return;
    let message: RepoWriteParentMessage;
    try {
      message = parseRepoWriteParentMessage(jsonText(value), this.protocolLimits);
    } catch (error) {
      this.fail(new RepoWriteProcessDisconnectError(
        "protocol",
        "Repo writer parent sent a malformed or over-limit IPC frame.",
        { cause: error }
      ), true);
      return;
    }
    if (this.messages.size === 0) {
      if (this.buffered.length >= this.limits.maxBufferedMessages) {
        this.fail(new RepoWriteProcessDisconnectError(
          "capacity",
          "Repo writer parent exceeded the bounded pre-listener message buffer."
        ), true);
        return;
      }
      this.buffered.push(message);
      return;
    }
    this.publish(message);
  };

  private readonly handleDisconnect = (): void => {
    this.fail(new RepoWriteProcessDisconnectError(
      "disconnect",
      "Repo writer parent IPC channel disconnected."
    ));
  };

  private sendPayload(payload: object): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (!this.endpoint.send || this.endpoint.connected !== true) {
      const error = new RepoWriteProcessDisconnectError(
        "disconnect",
        "Repo writer parent IPC channel is not connected."
      );
      this.fail(error);
      return Promise.reject(error);
    }
    if (this.pendingSends >= this.limits.maxPendingSends) {
      return Promise.reject(new RepoWriteProcessCapacityError(
        "Repo writer child exceeded the bounded pending-send limit."
      ));
    }
    this.pendingSends += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: RepoWriteProcessDisconnectError) => {
        if (settled) return;
        settled = true;
        this.pendingSendRejectors.delete(abort);
        this.pendingSends -= 1;
        if (error) reject(error);
        else resolve();
      };
      const abort = (error: RepoWriteProcessDisconnectError) => settle(error);
      this.pendingSendRejectors.add(abort);
      try {
        this.endpoint.send!(payload, (error) => {
          if (!error) {
            settle();
            return;
          }
          const disconnect = new RepoWriteProcessDisconnectError(
            "send",
            `Repo writer child IPC send failed: ${error.message}`,
            { cause: error }
          );
          this.fail(disconnect);
        });
      } catch (error) {
        const disconnect = new RepoWriteProcessDisconnectError(
          "send",
          "Repo writer child IPC send threw before completion.",
          { cause: error }
        );
        this.fail(disconnect);
      }
    });
  }

  private flushBuffered(): void {
    while (!this.terminalError && this.messages.size > 0 && this.buffered.length > 0) {
      this.publish(this.buffered.shift()!);
    }
  }

  private publish(message: RepoWriteParentMessage): void {
    try {
      for (const listener of this.messages) listener(message);
    } catch (error) {
      this.fail(new RepoWriteProcessDisconnectError(
        "listener",
        "Repo writer child message listener failed.",
        { cause: error }
      ), true);
    }
  }

  private fail(error: RepoWriteProcessDisconnectError, disconnect = false): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.buffered.length = 0;
    this.endpoint.off("message", this.handleMessage);
    this.endpoint.off("disconnect", this.handleDisconnect);
    for (const reject of [...this.pendingSendRejectors]) reject(error);
    if (disconnect && this.endpoint.connected === true) this.endpoint.disconnect?.();
    for (const listener of this.disconnects) listener(error);
    this.disconnects.clear();
    this.messages.clear();
  }
}

function defaultFork(
  modulePath: string | URL,
  args: ReadonlyArray<string>,
  options: ForkOptions
): ChildProcess {
  return fork(modulePath, [...args], options);
}

function resolveTransportLimits(
  overrides: Partial<RepoWriteProcessTransportLimits> = {}
): RepoWriteProcessTransportLimits {
  const limits = { ...defaultTransportLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function jsonText(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new Error("Repo writer IPC value is not JSON serializable.", { cause: error });
  }
  if (text === undefined) throw new Error("Repo writer IPC value is not a JSON frame.");
  return text;
}
