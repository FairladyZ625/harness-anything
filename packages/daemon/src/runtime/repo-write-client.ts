// @slice-activation P5-W2 repo-writer foundation; production dispatch and durable receipt lookup remain activation work owned by task_01KY6QFFC306JRW8JW4Y2ND2TM.
import {
  repoWriteProtocolType,
  type RepoWriteChildMessage,
  type RepoWriteCommandDto,
  type RepoWriteJsonObject,
  type RepoWriteOperationLookupResult,
  type RepoWriteTelemetryFrame
} from "./repo-write-protocol.ts";
import { repoWriteTerminalReceiptMatches } from "./repo-write-terminal-receipt.ts";
import type {
  RepoWriteClientLimits,
  RepoWriteClientOptions
} from "./repo-write-client-contract.ts";
export type {
  RepoWriteClientLimits,
  RepoWriteClientOptions,
  RepoWriteClientTransport
} from "./repo-write-client-contract.ts";
import {
  RepoWriteClientCapacityError,
  RepoWriteClientClosedError,
  RepoWriteDrainError,
  RepoWriteLookupError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError,
  RepoWriteProtocolViolationError,
  RepoWriteReadyTimeoutError,
  RepoWriteSendDeliveryError,
  RepoWriteShutdownTimeoutError
} from "./repo-write-client-errors.ts";
export {
  RepoWriteClientCapacityError,
  RepoWriteClientClosedError,
  RepoWriteDrainError,
  RepoWriteLookupError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError,
  RepoWriteProtocolViolationError,
  RepoWriteReadyTimeoutError,
  RepoWriteSendDeliveryError,
  RepoWriteShutdownTimeoutError,
  type RepoWriteSendDelivery
} from "./repo-write-client-errors.ts";

interface PendingSubmit {
  readonly requestId: string;
  readonly command: RepoWriteCommandDto;
  readonly resolve: (receipt: RepoWriteJsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  phase: "queued" | "submitted" | "prepared" | "proceeded";
  opId?: string;
}

interface PendingLookup {
  readonly requestId: string;
  readonly opId: string;
  readonly resolve: (result: RepoWriteOperationLookupResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
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
  readonly timer: NodeJS.Timeout;
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
      maxPendingRequests: options.limits?.maxPendingRequests ?? 1_024,
      readyTimeoutMs: options.limits?.readyTimeoutMs ?? 30_000,
      requestTimeoutMs: options.limits?.requestTimeoutMs ?? 30_000
    };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer`);
      }
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
    const timer = setTimeout(() => {
      const pending = this.readyPending;
      if (!pending || pending.promise !== promise) return;
      this.readyPending = undefined;
      const error = new RepoWriteReadyTimeoutError(this.limits.readyTimeoutMs);
      this.terminalError = error;
      pending.reject(error);
    }, this.limits.readyTimeoutMs);
    timer.unref();
    this.readyPending = {
      promise,
      resolve: resolveReady!,
      reject: rejectReady!,
      timer
    };
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
      const timer = setTimeout(
        () => this.expireSubmit(requestId),
        this.limits.requestTimeoutMs
      );
      timer.unref();
      this.pending.set(requestId, {
        requestId,
        command,
        resolve,
        reject,
        timer,
        phase: "queued"
      });
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
      const timer = setTimeout(
        () => this.expireLookup(requestId),
        this.limits.requestTimeoutMs
      );
      timer.unref();
      this.pendingLookups.set(requestId, {
        requestId,
        opId,
        resolve,
        reject,
        timer,
        phase: "queued"
      });
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
    if (this.readyPending) clearTimeout(this.readyPending.timer);
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
      if (this.options.expectedArtifactIdentity !== undefined
        && message.artifactIdentity !== this.options.expectedArtifactIdentity) {
        this.failProtocol(
          "Repo writer READY artifact identity does not match the pinned entrypoint."
        );
        return;
      }
      this.ready = true;
      if (this.readyPending) clearTimeout(this.readyPending.timer);
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
      if (!repoWriteTerminalReceiptMatches(message.outcome, message.receipt)) {
        this.failProtocol("Repo writer terminal receipt does not match its durable outcome.");
        return;
      }
      clearTimeout(pending.timer);
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
      if ((message.state === "committed" || message.state === "rejected")
        && !repoWriteTerminalReceiptMatches(message.outcome, message.receipt)) {
        this.failProtocol("Repo writer status receipt does not match its durable outcome.");
        return;
      }
      clearTimeout(pending.timer);
      this.pendingLookups.delete(message.requestId);
      if (message.state === "committed") {
        pending.resolve({ state: "committed", outcome: "committed", receipt: message.receipt });
      } else if (message.state === "rejected") {
        pending.resolve({ state: "rejected", outcome: "rejected", receipt: message.receipt });
      } else {
        pending.resolve({ state: message.state });
      }
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
        clearTimeout(lookup.timer);
        this.pendingLookups.delete(message.requestId);
        lookup.reject(new RepoWriteLookupError(message.code, message.diagnostic, lookup.opId));
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending || (message.opId !== undefined && pending.opId !== message.opId)) {
        this.failProtocol("Repo writer failure correlation does not match the pending request.");
        return;
      }
      clearTimeout(pending.timer);
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
    if (this.readyPending) clearTimeout(this.readyPending.timer);
    this.readyPending?.reject(notStarted);
    this.readyPending = undefined;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
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
      clearTimeout(pending.timer);
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
    if (this.readyPending) clearTimeout(this.readyPending.timer);
    this.readyPending?.reject(violation);
    this.readyPending = undefined;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(pending.opId
        ? new RepoWriteOutcomeUnknownError(violation.code, violation.message, pending.opId)
        : new RepoWriteNotStartedError(violation.code, violation.message));
    }
    for (const [requestId, pending] of this.pendingLookups) {
      clearTimeout(pending.timer);
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

  private expireSubmit(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    const diagnostic =
      `Repo writer request exceeded its ${this.limits.requestTimeoutMs}ms deadline.`;
    pending.reject(pending.phase === "proceeded" && pending.opId
      ? new RepoWriteOutcomeUnknownError(
          "REPO_WRITE_REQUEST_TIMEOUT",
          diagnostic,
          pending.opId
        )
      : new RepoWriteNotStartedError(
          "REPO_WRITE_REQUEST_TIMEOUT",
          diagnostic,
          pending.opId
        ));
  }

  private expireLookup(requestId: string): void {
    const pending = this.pendingLookups.get(requestId);
    if (!pending) return;
    this.pendingLookups.delete(requestId);
    pending.reject(new RepoWriteLookupError(
      "REPO_WRITE_LOOKUP_TIMEOUT",
      `Repo writer lookup exceeded its ${this.limits.requestTimeoutMs}ms deadline.`,
      pending.opId
    ));
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
    clearTimeout(pending.timer);
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
    clearTimeout(pending.timer);
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
