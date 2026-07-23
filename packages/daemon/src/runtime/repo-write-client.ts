// @slice-activation P5-W2 repo-writer foundation; production dispatch and durable receipt lookup remain activation work owned by task_01KY6QFFC306JRW8JW4Y2ND2TM.
import {
  repoWriteProtocolType,
  type RepoWriteChildMessage,
  type RepoWriteCommandDto,
  type RepoWriteJsonObject,
  type RepoWriteOperationLookupResult,
  type RepoWriteParentMessage,
  type RepoWriteTelemetryFrame
} from "./repo-write-protocol.ts";

export interface RepoWriteClientTransport {
  /**
   * A synchronous throw means the frame was definitely not sent. Asynchronous
   * rejection must use RepoWriteSendDeliveryError when delivery is knowable;
   * an untyped rejection is conservatively treated as possibly sent.
   */
  readonly send: (message: RepoWriteParentMessage) => void | Promise<void>;
  readonly onMessage: (listener: (message: RepoWriteChildMessage) => void) => () => void;
  readonly onDisconnect: (listener: (error: Error) => void) => () => void;
}

export type RepoWriteSendDelivery = "definitely-not-sent" | "possibly-sent";

export class RepoWriteSendDeliveryError extends Error {
  readonly delivery: RepoWriteSendDelivery;

  constructor(
    delivery: RepoWriteSendDelivery,
    message: string,
    options: { readonly cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RepoWriteSendDeliveryError";
    this.delivery = delivery;
  }
}

export interface RepoWriteClientOptions {
  readonly repoId: string;
  readonly generation: number;
  readonly transport: RepoWriteClientTransport;
  readonly limits?: Partial<RepoWriteClientLimits>;
  readonly onTelemetry: (frame: RepoWriteTelemetryFrame) => void;
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

export class RepoWriteLookupError extends Error {
  readonly code: string;
  readonly opId: string;
  readonly replay = "caller-may-retry" as const;

  constructor(code: string, message: string, opId: string) {
    super(message);
    this.name = "RepoWriteLookupError";
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

interface PendingLookup {
  readonly requestId: string;
  readonly opId: string;
  readonly resolve: (result: RepoWriteOperationLookupResult) => void;
  readonly reject: (error: Error) => void;
  phase: "queued" | "sent";
}

interface PendingShutdown {
  readonly requestId: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  sent: boolean;
}

interface PendingReady {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class RepoWriteClient {
  private readonly options: RepoWriteClientOptions;
  private readonly limits: RepoWriteClientLimits;
  private readonly pending = new Map<string, PendingSubmit>();
  private readonly pendingLookups = new Map<string, PendingLookup>();
  private readyPending: PendingReady | undefined;
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
    if (this.closing) return Promise.reject(new RepoWriteClientClosedError());
    if (this.readyPending) return this.readyPending.promise;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.readyPending = { promise, resolve: resolveReady!, reject: rejectReady! };
    return promise;
  }

  submit(command: RepoWriteCommandDto): Promise<RepoWriteJsonObject> {
    if (this.closing) return Promise.reject(new RepoWriteClientClosedError());
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.pendingRequestCount() >= this.limits.maxPendingRequests) {
      return Promise.reject(new RepoWriteClientCapacityError());
    }
    const requestId = this.nextRequestId();
    const result = new Promise<RepoWriteJsonObject>((resolve, reject) => {
      this.pending.set(requestId, { requestId, command, resolve, reject, phase: "queued" });
    });
    if (this.ready) this.dispatchSubmit(requestId);
    return result;
  }

  lookup(opId: string): Promise<RepoWriteOperationLookupResult> {
    if (!opId.trim()) return Promise.reject(new Error("opId must be a non-empty identifier"));
    if (this.closing) return Promise.reject(new RepoWriteClientClosedError());
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.pendingRequestCount() >= this.limits.maxPendingRequests) {
      return Promise.reject(new RepoWriteClientCapacityError());
    }
    const requestId = this.nextRequestId();
    const result = new Promise<RepoWriteOperationLookupResult>((resolve, reject) => {
      this.pendingLookups.set(requestId, { requestId, opId, resolve, reject, phase: "queued" });
    });
    if (this.ready) this.dispatchLookup(requestId);
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
    this.readyPending?.reject(new RepoWriteClientClosedError());
    this.readyPending = undefined;
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
      this.rejectSendFailure(requestId, error, true);
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
      this.readyPending?.resolve();
      this.readyPending = undefined;
      for (const requestId of this.pending.keys()) this.dispatchSubmit(requestId);
      for (const requestId of this.pendingLookups.keys()) this.dispatchLookup(requestId);
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
    if (message.kind === "status") {
      const pending = this.pendingLookups.get(message.requestId);
      if (!pending || pending.phase !== "sent" || pending.opId !== message.opId) {
        this.failProtocol("Repo writer status correlation does not match the pending lookup.");
        return;
      }
      this.pendingLookups.delete(message.requestId);
      pending.resolve(message.state === "committed"
        ? { state: "committed", outcome: message.outcome, receipt: message.receipt }
        : { state: message.state });
      return;
    }
    if (message.kind === "telemetry") {
      if (!this.telemetryMatchesPendingRequest(message)) {
        this.failProtocol("Repo writer telemetry does not match a pending request.");
        return;
      }
      try {
        this.options.onTelemetry(message);
      } catch {
        this.failProtocol("Repo writer telemetry observer failed.");
      }
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
      const lookup = this.pendingLookups.get(message.requestId);
      if (lookup) {
        if (lookup.phase !== "sent" || message.outcome !== "not-started" || message.opId !== lookup.opId) {
          this.failProtocol("Repo writer lookup failure has an invalid recovery boundary.");
          return;
        }
        this.pendingLookups.delete(message.requestId);
        lookup.reject(new RepoWriteLookupError(message.code, message.diagnostic, lookup.opId));
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
      if (this.pending.size > 0 || this.pendingLookups.size > 0) {
        this.failProtocol("Repo writer reported drained while accepted requests remain unresolved.");
        return;
      }
      clearTimeout(shutdown.timer);
      this.ready = false;
      this.terminalError = new RepoWriteClientClosedError();
      shutdown.resolve();
      return;
    }
    const unhandled: never = message;
    this.failProtocol(`Repo writer sent an unhandled child frame: ${String(unhandled)}`);
  }

  private handleDisconnect(error: Error): void {
    this.ready = false;
    const notStarted = new RepoWriteNotStartedError(
      "CAPSULE_DISCONNECTED",
      `Repo writer disconnected before the request started: ${error.message}`
    );
    this.readyPending?.reject(notStarted);
    this.readyPending = undefined;
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
    for (const [requestId, pending] of this.pendingLookups) {
      this.pendingLookups.delete(requestId);
      pending.reject(new RepoWriteLookupError(
        "CAPSULE_DISCONNECTED",
        `Repo writer disconnected during outcome lookup: ${error.message}`,
        pending.opId
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
    try {
      this.options.onProtocolViolation?.(violation);
    } catch {
      // A diagnostic observer cannot prevent the client from failing closed.
    }
    this.readyPending?.reject(violation);
    this.readyPending = undefined;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.reject(pending.opId
        ? new RepoWriteOutcomeUnknownError(violation.code, violation.message, pending.opId)
        : new RepoWriteNotStartedError(violation.code, violation.message));
    }
    for (const [requestId, pending] of this.pendingLookups) {
      this.pendingLookups.delete(requestId);
      pending.reject(new RepoWriteLookupError(violation.code, violation.message, pending.opId));
    }
    const shutdown = this.shutdownPending;
    if (shutdown) {
      clearTimeout(shutdown.timer);
      shutdown.reject(violation);
    }
  }

  private dispatchLookup(requestId: string): void {
    const pending = this.pendingLookups.get(requestId);
    if (!pending || pending.phase !== "queued") return;
    pending.phase = "sent";
    try {
      const sent = this.options.transport.send({
        ...this.frameBase(),
        kind: "status",
        requestId,
        opId: pending.opId
      });
      void Promise.resolve(sent).catch((error: unknown) => this.rejectLookupSend(requestId, error));
    } catch (error) {
      this.rejectLookupSend(requestId, error);
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

  private rejectSendFailure(requestId: string, error: unknown, synchronous = false): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    const message = error instanceof Error ? error.message : String(error);
    const definitelyNotSent = synchronous
      || (error instanceof RepoWriteSendDeliveryError && error.delivery === "definitely-not-sent");
    pending.reject(pending.opId && !definitelyNotSent
      ? new RepoWriteOutcomeUnknownError("CAPSULE_SEND_FAILED", message, pending.opId)
      : new RepoWriteNotStartedError("CAPSULE_SEND_FAILED", message, pending.opId));
  }

  private rejectShutdownSend(error: unknown): void {
    const shutdown = this.shutdownPending;
    if (!shutdown) return;
    clearTimeout(shutdown.timer);
    const message = error instanceof Error ? error.message : String(error);
    shutdown.reject(new RepoWriteDrainError("CAPSULE_SEND_FAILED", message));
  }

  private rejectLookupSend(requestId: string, error: unknown): void {
    const pending = this.pendingLookups.get(requestId);
    if (!pending) return;
    this.pendingLookups.delete(requestId);
    const message = error instanceof Error ? error.message : String(error);
    pending.reject(new RepoWriteLookupError("CAPSULE_SEND_FAILED", message, pending.opId));
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
      this.rejectSendFailure(pending.requestId, error, true);
    }
  }

  private telemetryMatchesPendingRequest(message: RepoWriteTelemetryFrame): boolean {
    const submit = this.pending.get(message.requestId);
    if (submit) {
      return message.opId === undefined || submit.opId === message.opId;
    }
    const lookup = this.pendingLookups.get(message.requestId);
    if (lookup) {
      return lookup.phase === "sent" && (message.opId === undefined || lookup.opId === message.opId);
    }
    const shutdown = this.shutdownPending;
    return shutdown?.sent === true
      && shutdown.requestId === message.requestId
      && message.opId === undefined;
  }

  private pendingRequestCount(): number {
    return this.pending.size + this.pendingLookups.size;
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
