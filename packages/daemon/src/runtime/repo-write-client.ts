// @slice-activation P5-W2 repo-writer foundation; production dispatch and durable receipt lookup remain activation work owned by task_01KY6QFFC306JRW8JW4Y2ND2TM.
import {
  type RepoWriteChildMessage,
  type RepoWriteCommandDto,
  type RepoWriteJsonObject,
  type RepoWriteOperationLookupResult
} from "./repo-write-protocol.ts";
import { repoWriteTerminalReceiptMatches } from "./repo-write-terminal-receipt.ts";
import { RepoWriteDirectClientLane } from "./repo-write-client-direct.ts";
import {
  createPendingRepoWriteLookup,
  createPendingRepoWriteSubmit,
  type PendingLookup,
  type PendingShutdown,
  type PendingSubmit
} from "./repo-write-client-pending.ts";
import type { RepoWriteClientLimits, RepoWriteClientOptions } from "./repo-write-client-contract.ts";
import { resolveRepoWriteClientLimits } from "./repo-write-client-limits.ts";
import { RepoWriteClientReadyGate } from "./repo-write-client-ready.ts";
import { disconnectRepoWritePendingRequests } from "./repo-write-client-disconnect.ts";
import {
  expireRepoWritePendingSubmit,
  rejectRepoWriteQueuedRequests,
  repoWritePendingFailureTransitionError
} from "./repo-write-client-pending-lifecycle.ts";
import {
  expireRepoWriteLookup,
  failRepoWriteLookup,
  failRepoWriteSubmit
} from "./repo-write-client-timeout.ts";
import {
  recordRepoWriteClientTelemetry,
  repoWriteTelemetryMatchesPendingRequest
} from "./repo-write-client-telemetry.ts";
import {
  observeRepoWriteRecoveryDiagnostic,
  observeRepoWriteRetryBudgetSignal,
  observeRepoWriteTelemetry,
  repoWriteClientFrameBase
} from "./repo-write-client-observers.ts";
import {
  finishRepoWriteParentPerformanceTiming,
  markRepoWriteChildStarted
} from "./repo-write-parent-performance.ts";
import { advanceRepoWritePhase } from "./repo-write-phase.ts";
export type { RepoWriteClientLimits, RepoWriteClientOptions, RepoWriteClientTransport } from "./repo-write-client-contract.ts";
import {
  RepoWriteClientCapacityError,
  RepoWriteClientClosedError,
  RepoWriteDrainError,
  RepoWriteIpcPayloadTooLargeError,
  RepoWriteLookupError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError,
  RepoWriteProtocolViolationError,
  RepoWriteSendDeliveryError,
  RepoWriteShutdownTimeoutError
} from "./repo-write-client-errors.ts";
export {
  RepoWriteClientCapacityError,
  RepoWriteClientClosedError,
  RepoWriteDrainError,
  RepoWriteIpcPayloadTooLargeError,
  RepoWriteLookupError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError,
  RepoWriteProtocolViolationError,
  RepoWriteStartupStalledError,
  RepoWriteSendDeliveryError,
  RepoWriteShutdownTimeoutError,
  type RepoWriteSendDelivery
} from "./repo-write-client-errors.ts";
export {
  RepoWriteDirectOutcomeUnknownError,
  RepoWriteReadyTimeoutError
} from "./repo-write-client-errors.ts";

export class RepoWriteClient {
  private readonly options: RepoWriteClientOptions;
  private readonly limits: RepoWriteClientLimits;
  private readonly pending = new Map<string, PendingSubmit>();
  private readonly directLane: RepoWriteDirectClientLane;
  private readonly pendingLookups = new Map<string, PendingLookup>();
  private readonly readyGate: RepoWriteClientReadyGate;
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
    this.limits = resolveRepoWriteClientLimits(options.limits);
    this.directLane = new RepoWriteDirectClientLane({
      repoId: options.repoId,
      generation: options.generation,
      requestTimeoutMs: this.limits.requestTimeoutMs,
      transport: options.transport,
      failProtocol: (message) => this.failProtocol(message),
      onRequestTimeout: options.onRequestTimeout,
      onRequestFailure: options.onRequestFailure
    });
    this.readyGate = new RepoWriteClientReadyGate({
      stallTimeoutMs: this.limits.readyTimeoutMs,
      onStall: (error) => {
        this.terminalError = error;
        rejectRepoWriteQueuedRequests(this.pending, this.directLane, this.pendingLookups, error);
      }
    });
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
    return this.readyGate.wait();
  }

  submit(command: RepoWriteCommandDto): Promise<RepoWriteJsonObject> {
    if (this.closing) return Promise.reject(new RepoWriteClientClosedError());
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.pendingRequestCount() >= this.limits.maxPendingRequests) {
      return Promise.reject(new RepoWriteClientCapacityError());
    }
    const requestId = this.nextRequestId();
    const result = new Promise<RepoWriteJsonObject>((resolve, reject) => {
      this.pending.set(requestId, createPendingRepoWriteSubmit({
        requestId,
        command,
        resolve,
        reject
      }));
    });
    if (this.ready) this.dispatchSubmit(requestId);
    return result;
  }

  direct(command: RepoWriteCommandDto): Promise<RepoWriteJsonObject> {
    if (this.closing) return Promise.reject(new RepoWriteClientClosedError());
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.pendingRequestCount() >= this.limits.maxPendingRequests) {
      return Promise.reject(new RepoWriteClientCapacityError());
    }
    const requestId = this.nextRequestId();
    return this.directLane.submit(requestId, command, this.ready);
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
      this.pendingLookups.set(requestId, createPendingRepoWriteLookup({
        requestId,
        opId,
        resolve,
        reject,
        timer
      }));
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
    const closed = new RepoWriteClientClosedError();
    this.readyGate.reject(closed);
    rejectRepoWriteQueuedRequests(this.pending, this.directLane, this.pendingLookups, closed);
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
    pending.phase = advanceRepoWritePhase("parent", "submit", pending.phase);
    pending.timer = setTimeout(
      () => this.expireSubmit(requestId),
      this.limits.requestTimeoutMs
    );
    pending.timer.unref();
    try {
      const sent = this.options.transport.send({
        ...repoWriteClientFrameBase(this.options.repoId, this.options.generation),
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
    if (message.kind === "startup-progress") {
      if (this.ready) {
        this.failProtocol("Repo writer sent startup progress after READY.");
        return;
      }
      this.readyGate.observe(message);
      return;
    }
    if (message.kind === "ready") {
      if (this.options.expectedArtifactIdentity !== undefined
        && message.artifactIdentity !== this.options.expectedArtifactIdentity) {
        this.failProtocol(
          "Repo writer READY artifact identity does not match the pinned entrypoint."
        );
        return;
      }
      this.ready = true;
      this.readyGate.resolve();
      for (const requestId of this.pending.keys()) this.dispatchSubmit(requestId);
      this.directLane.dispatchAll();
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
      pending.phase = advanceRepoWritePhase("parent", "prepared", pending.phase);
      pending.opId = message.opId;
      markRepoWriteChildStarted(pending.performanceTiming);
      this.dispatchProceed(pending);
      return;
    }
    if (message.kind === "accepted") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.opId !== message.opId
        || (pending.phase !== "prepared" && pending.phase !== "proceeded")) {
        this.failProtocol("Repo writer accepted correlation does not match the prepared request.");
        return;
      }
      advanceRepoWritePhase("parent", "accepted", pending.phase);
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
      pending.resolve(message.receipt);
      return;
    }
    if (message.kind === "terminal") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.opId !== message.opId
        || (pending.phase !== "prepared" && pending.phase !== "proceeded")) {
        this.failProtocol("Repo writer terminal correlation does not match the prepared request.");
        return;
      }
      advanceRepoWritePhase("parent", "terminal", pending.phase);
      if (!repoWriteTerminalReceiptMatches(message.outcome, message.receipt)) {
        this.failProtocol("Repo writer terminal receipt does not match its durable outcome.");
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
      pending.resolve(message.receipt);
      return;
    }
    if (message.kind === "direct-result") {
      this.directLane.handleResult(message);
      return;
    }
    if (message.kind === "direct-failure") {
      this.directLane.handleUnknown(message);
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
      finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
      if (message.state === "committed") {
        pending.resolve({ state: "committed", outcome: "committed", receipt: message.receipt });
      } else if (message.state === "rejected") {
        pending.resolve({ state: "rejected", outcome: "rejected", receipt: message.receipt });
      } else if (message.state === "accepted" || message.state === "settlement-failed") {
        pending.resolve({ state: message.state, receipt: message.receipt });
      } else {
        pending.resolve({ state: message.state });
      }
      return;
    }
    if (message.kind === "telemetry") {
      if (!repoWriteTelemetryMatchesPendingRequest(
        message,
        this.pending,
        this.pendingLookups,
        this.directLane,
        this.shutdownPending
      )) {
        this.failProtocol("Repo writer telemetry does not match a pending request.");
        return;
      }
      recordRepoWriteClientTelemetry(
        message,
        this.pending,
        this.pendingLookups,
        this.directLane
      );
      observeRepoWriteTelemetry(
        this.options.onTelemetry,
        message,
        () => this.failProtocol("Repo writer telemetry observer failed.")
      );
      return;
    }
    if (message.kind === "recovery-deferred" || message.kind === "recovery-rejected") {
      observeRepoWriteRecoveryDiagnostic(this.options.onDiagnostic, message);
      return;
    }
    if (message.kind === "retry-budget-signal") {
      observeRepoWriteRetryBudgetSignal(this.options.onRetryBudgetSignal, message);
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
        failRepoWriteLookup(lookup, message, this.options.onRequestFailure);
        return;
      }
      if (this.directLane.handleNotStarted(message)) return;
      const pending = this.pending.get(message.requestId);
      if (!pending || (message.opId !== undefined && pending.opId !== message.opId)) {
        this.failProtocol("Repo writer failure correlation does not match the pending request.");
        return;
      }
      const failureTransitionError = repoWritePendingFailureTransitionError(pending, message);
      if (failureTransitionError !== undefined) {
        this.failProtocol(failureTransitionError);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      failRepoWriteSubmit(pending, message, this.options.onRequestFailure);
      return;
    }
    if (message.kind === "drained") {
      const shutdown = this.shutdownPending;
      if (!shutdown || !shutdown.sent || shutdown.requestId !== message.requestId) {
        this.failProtocol("Repo writer drained frame does not match the shutdown request.");
        return;
      }
      if (this.pending.size > 0 || this.directLane.size > 0 || this.pendingLookups.size > 0) {
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
    this.readyGate.reject(notStarted);
    disconnectRepoWritePendingRequests(
      this.pending,
      this.directLane,
      this.pendingLookups,
      error
    );
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
    this.readyGate.reject(violation);
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
      pending.reject(pending.opId
        ? new RepoWriteOutcomeUnknownError(violation.code, violation.message, pending.opId)
        : new RepoWriteNotStartedError(violation.code, violation.message));
    }
    this.directLane.fail(violation);
    for (const [requestId, pending] of this.pendingLookups) {
      clearTimeout(pending.timer);
      this.pendingLookups.delete(requestId);
      finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
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
        ...repoWriteClientFrameBase(this.options.repoId, this.options.generation),
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
    expireRepoWritePendingSubmit(
      requestId,
      this.pending,
      this.limits,
      this.options.onRequestTimeout
    );
  }

  private expireLookup(requestId: string): void {
    const pending = this.pendingLookups.get(requestId);
    if (!pending) return;
    this.pendingLookups.delete(requestId);
    expireRepoWriteLookup(
      pending,
      this.limits.requestTimeoutMs,
      this.options.onRequestTimeout
    );
  }

  private dispatchShutdown(): void {
    const shutdown = this.shutdownPending;
    if (!shutdown || shutdown.sent || !this.ready) return;
    shutdown.sent = true;
    try {
      const sent = this.options.transport.send({
        ...repoWriteClientFrameBase(this.options.repoId, this.options.generation),
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
    finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
    if (error instanceof RepoWriteIpcPayloadTooLargeError) {
      pending.reject(error);
      return;
    }
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
    finishRepoWriteParentPerformanceTiming(pending.performanceTiming);
    const message = error instanceof Error ? error.message : String(error);
    pending.reject(new RepoWriteLookupError("CAPSULE_SEND_FAILED", message, pending.opId));
  }

  private dispatchProceed(pending: PendingSubmit): void {
    if (pending.phase !== "prepared") return;
    const proceededPhase = advanceRepoWritePhase("parent", "proceed", pending.phase);
    try {
      const sent = this.options.transport.send({
        ...repoWriteClientFrameBase(this.options.repoId, this.options.generation),
        kind: "proceed",
        requestId: pending.requestId,
        opId: pending.opId!
      });
      if (this.pending.has(pending.requestId)) pending.phase = proceededPhase;
      void Promise.resolve(sent).catch((error: unknown) => this.rejectSendFailure(pending.requestId, error));
    } catch (error) {
      this.rejectSendFailure(pending.requestId, error, true);
    }
  }
  private pendingRequestCount(): number {
    return this.pending.size + this.directLane.size + this.pendingLookups.size;
  }

  private nextRequestId(): string {
    this.sequence += 1;
    return `${this.options.generation}:${this.sequence}`;
  }
}
