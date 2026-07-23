import {
  repoWriteProtocolType,
  type RepoWriteChildMessage,
  type RepoWriteCommandDto,
  type RepoWriteJsonObject,
  type RepoWriteParentMessage
} from "./repo-write-protocol.ts";

export interface RepoWriteClientTransport {
  readonly send: (message: RepoWriteParentMessage) => void | Promise<void>;
  readonly onMessage: (listener: (message: RepoWriteChildMessage) => void) => () => void;
  readonly onDisconnect: (listener: (error: Error) => void) => () => void;
}

export interface RepoWriteClientOptions {
  readonly repoId: string;
  readonly generation: number;
  readonly transport: RepoWriteClientTransport;
  readonly limits?: Partial<RepoWriteClientLimits>;
  readonly onProtocolViolation?: (error: RepoWriteProtocolViolationError) => void;
}

export interface RepoWriteClientLimits {
  readonly maxPendingRequests: number;
}

export class RepoWriteClientCapacityError extends Error {
  readonly code = "REPO_WRITE_PENDING_LIMIT" as const;

  constructor() {
    super("Repo writer pending request limit reached.");
    this.name = "RepoWriteClientCapacityError";
  }
}

export class RepoWriteClientClosedError extends Error {
  readonly code = "REPO_WRITE_CLIENT_CLOSED" as const;

  constructor() {
    super("Repo writer client is draining or closed.");
    this.name = "RepoWriteClientClosedError";
  }
}

export class RepoWriteProtocolViolationError extends Error {
  readonly code = "REPO_WRITE_PROTOCOL_VIOLATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "RepoWriteProtocolViolationError";
  }
}

export class RepoWriteDrainError extends Error {
  readonly code: string;
  readonly outcome = "not-started" as const;
  readonly replay = "forbidden" as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RepoWriteDrainError";
    this.code = code;
  }
}

export class RepoWriteShutdownTimeoutError extends RepoWriteDrainError {
  constructor() {
    super("REPO_WRITE_DRAIN_TIMEOUT", "Repo writer drain timed out; the generation was not replaced.");
    this.name = "RepoWriteShutdownTimeoutError";
  }
}

export class RepoWriteNotStartedError extends Error {
  readonly code: string;
  readonly opId: string | undefined;
  readonly outcome = "not-started" as const;
  readonly replay = "caller-may-retry" as const;

  constructor(code: string, message: string, opId?: string) {
    super(message);
    this.name = "RepoWriteNotStartedError";
    this.code = code;
    this.opId = opId;
  }
}

export class RepoWriteOutcomeUnknownError extends Error {
  readonly code: string;
  readonly opId: string;
  readonly outcome = "unknown" as const;
  readonly replay = "forbidden" as const;

  constructor(code: string, message: string, opId: string) {
    super(message);
    this.name = "RepoWriteOutcomeUnknownError";
    this.code = code;
    this.opId = opId;
  }
}

interface PendingSubmit {
  readonly requestId: string;
  readonly command: RepoWriteCommandDto;
  readonly resolve: (receipt: RepoWriteJsonObject) => void;
  readonly reject: (error: Error) => void;
  phase: "queued" | "submitted" | "prepared" | "proceeded";
  opId?: string;
}

interface PendingShutdown {
  readonly requestId: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  sent: boolean;
}

export class RepoWriteClient {
  private readonly options: RepoWriteClientOptions;
  private readonly limits: RepoWriteClientLimits;
  private readonly pending = new Map<string, PendingSubmit>();
  private readonly readyWaiters: Array<{ readonly resolve: () => void; readonly reject: (error: Error) => void }> = [];
  private ready = false;
  private sequence = 0;
  private terminalError: Error | undefined;
  private closing = false;
  private shutdownPending: PendingShutdown | undefined;

  constructor(options: RepoWriteClientOptions) {
    if (!options.repoId.trim()) throw new Error("repoId must be a non-empty identifier");
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new Error("generation must be a positive safe integer");
    }
    this.options = options;
    this.limits = {
      maxPendingRequests: options.limits?.maxPendingRequests ?? 1_024
    };
    if (!Number.isSafeInteger(this.limits.maxPendingRequests) || this.limits.maxPendingRequests <= 0) {
      throw new Error("maxPendingRequests must be a positive safe integer");
    }
    options.transport.onMessage((message) => this.handleMessage(message));
    options.transport.onDisconnect((error) => this.handleDisconnect(error));
  }

  get connectionGeneration(): number {
    return this.options.generation;
  }

  waitUntilReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  submit(command: RepoWriteCommandDto): Promise<RepoWriteJsonObject> {
    if (this.closing) return Promise.reject(new RepoWriteClientClosedError());
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.pending.size >= this.limits.maxPendingRequests) {
      return Promise.reject(new RepoWriteClientCapacityError());
    }
    const requestId = this.nextRequestId();
    const result = new Promise<RepoWriteJsonObject>((resolve, reject) => {
      this.pending.set(requestId, { requestId, command, resolve, reject, phase: "queued" });
    });
    if (this.ready) this.dispatchSubmit(requestId);
    return result;
  }

  shutdown(options: { readonly timeoutMs?: number } = {}): Promise<void> {
    if (this.shutdownPending) return this.shutdownPending.promise;
    if (this.terminalError) return Promise.reject(this.terminalError);
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("timeoutMs must be a positive safe integer"));
    }
    this.closing = true;
    const requestId = this.nextRequestId();
    let resolveShutdown: (() => void) | undefined;
    let rejectShutdown: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    const timer = setTimeout(() => {
      this.shutdownPending?.reject(new RepoWriteShutdownTimeoutError());
    }, timeoutMs);
    timer.unref();
    this.shutdownPending = {
      requestId,
      promise,
      resolve: resolveShutdown!,
      reject: rejectShutdown!,
      timer,
      sent: false
    };
    if (this.ready) this.dispatchShutdown();
    return promise;
  }

  private dispatchSubmit(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.phase !== "queued") return;
    pending.phase = "submitted";
    try {
      const sent = this.options.transport.send({
        ...this.frameBase(),
        kind: "submit",
        requestId,
        command: pending.command
      });
      void Promise.resolve(sent).catch((error: unknown) => this.rejectSendFailure(requestId, error));
    } catch (error) {
      this.rejectSendFailure(requestId, error);
    }
  }

  private handleMessage(message: RepoWriteChildMessage): void {
    if (message.repoId !== this.options.repoId || message.generation !== this.options.generation) {
      this.failProtocol("Repo writer frame does not match the client's repo generation.");
      return;
    }
    if (this.terminalError) return;
    if (message.kind === "ready") {
      this.ready = true;
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
      for (const requestId of this.pending.keys()) this.dispatchSubmit(requestId);
      this.dispatchShutdown();
      return;
    }
    if (message.kind === "prepared") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.phase !== "submitted") {
        this.failProtocol("Repo writer sent a duplicate or unknown prepared request.");
        return;
      }
      pending.phase = "prepared";
      pending.opId = message.opId;
      this.dispatchProceed(pending);
      return;
    }
    if (message.kind === "terminal") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.opId !== message.opId
        || (pending.phase !== "prepared" && pending.phase !== "proceeded")) {
        this.failProtocol("Repo writer terminal correlation does not match the prepared request.");
        return;
      }
      this.pending.delete(message.requestId);
      pending.resolve(message.receipt);
      return;
    }
    if (message.kind === "failure") {
      const shutdown = this.shutdownPending;
      if (shutdown?.requestId === message.requestId) {
        if (!shutdown.sent || message.outcome !== "not-started" || message.opId !== undefined) {
          this.failProtocol("Repo writer shutdown failure has an invalid recovery boundary.");
          return;
        }
        clearTimeout(shutdown.timer);
        shutdown.reject(new RepoWriteDrainError(message.code, message.diagnostic));
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending || (message.opId !== undefined && pending.opId !== message.opId)) {
        this.failProtocol("Repo writer failure correlation does not match the pending request.");
        return;
      }
      this.pending.delete(message.requestId);
      pending.reject(message.outcome === "not-started"
        ? new RepoWriteNotStartedError(message.code, message.diagnostic, message.opId)
        : new RepoWriteOutcomeUnknownError(message.code, message.diagnostic, message.opId));
      return;
    }
    if (message.kind === "drained") {
      const shutdown = this.shutdownPending;
      if (!shutdown || !shutdown.sent || shutdown.requestId !== message.requestId) {
        this.failProtocol("Repo writer drained frame does not match the shutdown request.");
        return;
      }
      if (this.pending.size > 0) {
        this.failProtocol("Repo writer reported drained while accepted requests remain unresolved.");
        return;
      }
      clearTimeout(shutdown.timer);
      this.ready = false;
      this.terminalError = new RepoWriteClientClosedError();
      shutdown.resolve();
    }
  }

  private handleDisconnect(error: Error): void {
    this.ready = false;
    const notStarted = new RepoWriteNotStartedError(
      "CAPSULE_DISCONNECTED",
      `Repo writer disconnected before the request started: ${error.message}`
    );
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(notStarted);
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.reject(pending.opId
        ? new RepoWriteOutcomeUnknownError(
            "CAPSULE_DISCONNECTED",
            `Repo writer disconnected after preparation: ${error.message}`,
            pending.opId
          )
        : new RepoWriteNotStartedError(
            "CAPSULE_DISCONNECTED",
            `Repo writer disconnected before the request started: ${error.message}`
          ));
    }
    const shutdown = this.shutdownPending;
    if (shutdown) {
      clearTimeout(shutdown.timer);
      shutdown.reject(notStarted);
    }
    this.terminalError = notStarted;
  }

  private failProtocol(message: string): void {
    if (this.terminalError) return;
    const violation = new RepoWriteProtocolViolationError(message);
    this.ready = false;
    this.terminalError = violation;
    this.options.onProtocolViolation?.(violation);
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(violation);
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.reject(pending.opId
        ? new RepoWriteOutcomeUnknownError(violation.code, violation.message, pending.opId)
        : new RepoWriteNotStartedError(violation.code, violation.message));
    }
    const shutdown = this.shutdownPending;
    if (shutdown) {
      clearTimeout(shutdown.timer);
      shutdown.reject(violation);
    }
  }

  private dispatchShutdown(): void {
    const shutdown = this.shutdownPending;
    if (!shutdown || shutdown.sent || !this.ready) return;
    shutdown.sent = true;
    try {
      const sent = this.options.transport.send({
        ...this.frameBase(),
        kind: "shutdown",
        requestId: shutdown.requestId
      });
      void Promise.resolve(sent).catch((error: unknown) => this.rejectShutdownSend(error));
    } catch (error) {
      this.rejectShutdownSend(error);
    }
  }

  private rejectSendFailure(requestId: string, error: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    const message = error instanceof Error ? error.message : String(error);
    pending.reject(pending.opId
      ? new RepoWriteOutcomeUnknownError("CAPSULE_SEND_FAILED", message, pending.opId)
      : new RepoWriteNotStartedError("CAPSULE_SEND_FAILED", message));
  }

  private rejectShutdownSend(error: unknown): void {
    const shutdown = this.shutdownPending;
    if (!shutdown) return;
    clearTimeout(shutdown.timer);
    const message = error instanceof Error ? error.message : String(error);
    shutdown.reject(new RepoWriteDrainError("CAPSULE_SEND_FAILED", message));
  }

  private dispatchProceed(pending: PendingSubmit): void {
    try {
      const sent = this.options.transport.send({
        ...this.frameBase(),
        kind: "proceed",
        requestId: pending.requestId,
        opId: pending.opId!
      });
      if (this.pending.has(pending.requestId)) pending.phase = "proceeded";
      void Promise.resolve(sent).catch((error: unknown) => this.rejectSendFailure(pending.requestId, error));
    } catch (error) {
      this.rejectSendFailure(pending.requestId, error);
    }
  }

  private frameBase() {
    return {
      protocol: repoWriteProtocolType,
      repoId: this.options.repoId,
      generation: this.options.generation
    } as const;
  }

  private nextRequestId(): string {
    this.sequence += 1;
    return `${this.options.generation}:${this.sequence}`;
  }
}
