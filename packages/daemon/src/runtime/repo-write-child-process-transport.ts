// @slice-activation P5-W2 repo-writer foundation; production composition and supervision remain activation work owned by task_01KY6QFFC306JRW8JW4Y2ND2TM.
import {
  fork,
  type ChildProcess,
  type ForkOptions
} from "node:child_process";
import type { RepoWriteChildTransport } from "./repo-write-child-host.ts";
import {
  RepoWriteSendDeliveryError,
  type RepoWriteClientTransport,
  type RepoWriteSendDelivery
} from "./repo-write-client.ts";
import {
  notifyRepoWriteDisconnectListeners,
  repoWriteIpcJsonText,
  serializeRepoWriteIpcFrame
} from "./repo-write-ipc-shared.ts";
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

export class RepoWriteProcessDisconnectError extends RepoWriteSendDeliveryError {
  readonly code = "REPO_WRITE_PROCESS_DISCONNECTED" as const;
  readonly reason: RepoWriteDisconnectReason;
  readonly exitCode: number | undefined;
  readonly signal: NodeJS.Signals | undefined;

  constructor(
    reason: RepoWriteDisconnectReason,
    message: string,
    details: {
      readonly exitCode?: number;
      readonly signal?: NodeJS.Signals;
      readonly cause?: unknown;
      readonly delivery?: RepoWriteSendDelivery;
    } = {}
  ) {
    super(details.delivery ?? "possibly-sent", message, { cause: details.cause });
    this.name = "RepoWriteProcessDisconnectError";
    this.reason = reason;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
  }
}

export class RepoWriteProcessCapacityError extends RepoWriteSendDeliveryError {
  readonly code = "REPO_WRITE_PROCESS_CAPACITY" as const;

  constructor(message: string) {
    super("definitely-not-sent", message);
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
    const payload = serializeRepoWriteIpcFrame(message, (frame) =>
      stringifyRepoWriteParentMessage(frame, this.protocolLimits), "parent");
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
      message = parseRepoWriteChildMessage(repoWriteIpcJsonText(value), this.protocolLimits);
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
    if (this.terminalError) {
      throw new RepoWriteSendDeliveryError(
        "definitely-not-sent",
        "Repo writer child process is already disconnected.",
        { cause: this.terminalError }
      );
    }
    if (!this.child.connected) {
      const error = new RepoWriteProcessDisconnectError(
        "disconnect",
        "Repo writer child IPC channel is not connected.",
        { delivery: "definitely-not-sent" }
      );
      this.fail(error, false, true);
      throw error;
    }
    if (this.pendingSends >= this.limits.maxPendingSends) {
      throw new RepoWriteProcessCapacityError(
        "Repo writer parent exceeded the bounded pending-send limit."
      );
    }
    this.pendingSends += 1;
    let resolveSend: (() => void) | undefined;
    let rejectSend: ((error: RepoWriteProcessDisconnectError) => void) | undefined;
    const result = new Promise<void>((resolve, reject) => {
      resolveSend = resolve;
      rejectSend = reject;
    });
    let settled = false;
    const settle = (error?: RepoWriteProcessDisconnectError) => {
      if (settled) return;
      settled = true;
      this.pendingSendRejectors.delete(abort);
      this.pendingSends -= 1;
      if (error) rejectSend!(error);
      else resolveSend!();
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
      settle();
      const disconnect = new RepoWriteProcessDisconnectError(
        "send",
        "Repo writer parent IPC send threw before accepting the frame.",
        { cause: error, delivery: "definitely-not-sent" }
      );
      this.fail(disconnect, false, true);
      throw disconnect;
    }
    return result;
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

  private fail(
    error: RepoWriteProcessDisconnectError,
    terminate = false,
    deferDisconnectNotification = false
  ): void {
    if (this.terminalError) return;
    this.terminalError = error;
    if (this.pendingDisconnect) clearTimeout(this.pendingDisconnect);
    this.pendingDisconnect = undefined;
    this.buffered.length = 0;
    this.removeProcessListeners();
    const pendingSendError = error.delivery === "possibly-sent"
      ? error
      : new RepoWriteProcessDisconnectError(error.reason, error.message, {
          cause: error,
          exitCode: error.exitCode,
          signal: error.signal
        });
    for (const reject of [...this.pendingSendRejectors]) reject(pendingSendError);
    if (terminate && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
    const disconnectListeners = [...this.disconnects];
    this.disconnects.clear();
    this.messages.clear();
    notifyRepoWriteDisconnectListeners(disconnectListeners, error, deferDisconnectNotification);
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
    const payload = serializeRepoWriteIpcFrame(message, (frame) =>
      stringifyRepoWriteChildMessage(frame, this.protocolLimits), "child");
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
      message = parseRepoWriteParentMessage(repoWriteIpcJsonText(value), this.protocolLimits);
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
    if (this.terminalError) {
      throw new RepoWriteSendDeliveryError(
        "definitely-not-sent",
        "Repo writer parent process is already disconnected.",
        { cause: this.terminalError }
      );
    }
    if (!this.endpoint.send || this.endpoint.connected !== true) {
      const error = new RepoWriteProcessDisconnectError(
        "disconnect",
        "Repo writer parent IPC channel is not connected.",
        { delivery: "definitely-not-sent" }
      );
      this.fail(error, false, true);
      throw error;
    }
    if (this.pendingSends >= this.limits.maxPendingSends) {
      throw new RepoWriteProcessCapacityError(
        "Repo writer child exceeded the bounded pending-send limit."
      );
    }
    this.pendingSends += 1;
    let resolveSend: (() => void) | undefined;
    let rejectSend: ((error: RepoWriteProcessDisconnectError) => void) | undefined;
    const result = new Promise<void>((resolve, reject) => {
      resolveSend = resolve;
      rejectSend = reject;
    });
    let settled = false;
    const settle = (error?: RepoWriteProcessDisconnectError) => {
      if (settled) return;
      settled = true;
      this.pendingSendRejectors.delete(abort);
      this.pendingSends -= 1;
      if (error) rejectSend!(error);
      else resolveSend!();
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
      settle();
      const disconnect = new RepoWriteProcessDisconnectError(
        "send",
        "Repo writer child IPC send threw before accepting the frame.",
        { cause: error, delivery: "definitely-not-sent" }
      );
      this.fail(disconnect, false, true);
      throw disconnect;
    }
    return result;
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

  private fail(
    error: RepoWriteProcessDisconnectError,
    disconnect = false,
    deferDisconnectNotification = false
  ): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.buffered.length = 0;
    this.endpoint.off("message", this.handleMessage);
    this.endpoint.off("disconnect", this.handleDisconnect);
    const pendingSendError = error.delivery === "possibly-sent"
      ? error
      : new RepoWriteProcessDisconnectError(error.reason, error.message, { cause: error });
    for (const reject of [...this.pendingSendRejectors]) reject(pendingSendError);
    if (disconnect && this.endpoint.connected === true) this.endpoint.disconnect?.();
    const disconnectListeners = [...this.disconnects];
    this.disconnects.clear();
    this.messages.clear();
    notifyRepoWriteDisconnectListeners(disconnectListeners, error, deferDisconnectNotification);
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
