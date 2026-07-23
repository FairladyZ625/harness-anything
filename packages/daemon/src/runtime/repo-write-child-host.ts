import {
  boundedRepoWriteDiagnostic,
  repoWriteProtocolType,
  type RepoWriteChildMessage,
  type RepoWriteCommandDto,
  type RepoWriteJsonObject,
  type RepoWriteOperationState,
  type RepoWriteParentMessage
} from "./repo-write-protocol.ts";

export interface RepoWriteChildTransport {
  readonly send: (message: RepoWriteChildMessage) => void | Promise<void>;
}

export interface RepoWritePrepareInput {
  readonly repoId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly command: RepoWriteCommandDto;
}

export interface RepoWritePreparedOperation {
  readonly opId: string;
  readonly execute: () => RepoWriteJsonObject | Promise<RepoWriteJsonObject>;
}

export interface RepoWriteLookupInput {
  readonly repoId: string;
  readonly generation: number;
  readonly opId: string;
}

export interface RepoWriteShutdownInput {
  readonly repoId: string;
  readonly generation: number;
}

export interface RepoWriteChildHostHooks {
  /**
   * Preparation must not perform canonical mutation. `execute` is the only
   * callback the host invokes after an exact requestId/opId proceed handshake.
   */
  readonly prepare: (
    input: RepoWritePrepareInput
  ) => RepoWritePreparedOperation | Promise<RepoWritePreparedOperation>;
  readonly lookup: (
    input: RepoWriteLookupInput
  ) => RepoWriteOperationState | Promise<RepoWriteOperationState>;
  readonly shutdown: (input: RepoWriteShutdownInput) => void | Promise<void>;
}

export interface RepoWriteChildHostLimits {
  readonly maxAdmissions: number;
  /**
   * Completed request history is never evicted inside a generation because
   * forgetting a requestId could admit a non-idempotent replay. The supervisor
   * must drain and replace the generation before this fail-closed bound.
   */
  readonly maxRetainedOperations: number;
  readonly shutdownTimeoutMs: number;
}

export interface RepoWriteChildHostOptions {
  readonly repoId: string;
  readonly generation: number;
  readonly transport: RepoWriteChildTransport;
  readonly hooks: RepoWriteChildHostHooks;
  readonly limits?: Partial<RepoWriteChildHostLimits>;
}

type OperationPhase = "preparing" | "prepared" | "proceeding" | "committed" | "failed" | "unknown";

interface HostedOperation {
  readonly requestId: string;
  phase: OperationPhase;
  opId?: string;
  execute?: RepoWritePreparedOperation["execute"];
  receipt?: RepoWriteJsonObject;
  admitted: boolean;
}

interface ShutdownAttempt {
  readonly requestId: string;
  readonly token: symbol;
  timer: ReturnType<typeof setTimeout>;
  completing: boolean;
}

const defaultLimits: RepoWriteChildHostLimits = {
  maxAdmissions: 64,
  maxRetainedOperations: 16_384,
  shutdownTimeoutMs: 5_000
};

export class RepoWriteChildHost {
  private readonly options: RepoWriteChildHostOptions;
  private readonly limits: RepoWriteChildHostLimits;
  private readonly operationsByRequest = new Map<string, HostedOperation>();
  private readonly operationsById = new Map<string, HostedOperation>();
  private readonly controlRequestIds = new Set<string>();
  private activeAdmissions = 0;
  private admissionOpen = true;
  private started = false;
  private starting = false;
  private drained = false;
  private shutdownAttempt: ShutdownAttempt | undefined;
  private shutdownHookPromise: Promise<void> | undefined;
  private outbound = Promise.resolve();

  constructor(options: RepoWriteChildHostOptions) {
    if (!options.repoId.trim()) throw new Error("repoId is required");
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new Error("generation must be a positive safe integer");
    }
    this.options = options;
    this.limits = {
      maxAdmissions: options.limits?.maxAdmissions ?? defaultLimits.maxAdmissions,
      maxRetainedOperations: options.limits?.maxRetainedOperations ?? defaultLimits.maxRetainedOperations,
      shutdownTimeoutMs: options.limits?.shutdownTimeoutMs ?? defaultLimits.shutdownTimeoutMs
    };
    assertPositiveLimit(this.limits.maxAdmissions, "maxAdmissions");
    assertPositiveLimit(this.limits.maxRetainedOperations, "maxRetainedOperations");
    assertPositiveLimit(this.limits.shutdownTimeoutMs, "shutdownTimeoutMs");
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.starting) throw new Error("repo writer child host start is already in progress");
    this.starting = true;
    try {
      await this.send({
        ...this.frameBase(),
        kind: "ready"
      });
      this.started = true;
    } finally {
      this.starting = false;
    }
  }

  async receive(message: RepoWriteParentMessage): Promise<void> {
    if (!this.started) throw new Error("repo writer child host must start before receiving messages");
    if (message.kind === "submit") return this.handleSubmit(message);
    if (message.kind === "proceed") return this.handleProceed(message);
    if (message.kind === "status") return this.handleStatus(message);
    return this.handleShutdown(message);
  }

  private async handleSubmit(message: Extract<RepoWriteParentMessage, { kind: "submit" }>): Promise<void> {
    const boundaryError = this.boundaryError(message);
    if (boundaryError) {
      await this.sendNotStarted(message.requestId, boundaryError, "submit rejected by capsule boundary");
      return;
    }
    const existing = this.operationsByRequest.get(message.requestId);
    if (existing) {
      await this.sendDuplicateSubmit(existing);
      return;
    }
    if (!this.admissionOpen) {
      await this.sendNotStarted(message.requestId, "ADMISSION_CLOSED", "writer admission is closed");
      return;
    }
    if (this.operationsByRequest.size >= this.limits.maxRetainedOperations) {
      await this.sendNotStarted(
        message.requestId,
        "RETAINED_HISTORY_FULL",
        "writer request history reached its fail-closed generation bound"
      );
      return;
    }
    if (this.activeAdmissions >= this.limits.maxAdmissions) {
      await this.sendNotStarted(message.requestId, "ADMISSION_FULL", "writer admission limit reached");
      return;
    }

    const operation: HostedOperation = {
      requestId: message.requestId,
      phase: "preparing",
      admitted: true
    };
    this.operationsByRequest.set(message.requestId, operation);
    this.activeAdmissions += 1;
    try {
      const prepared = await this.options.hooks.prepare({
        repoId: this.options.repoId,
        generation: this.options.generation,
        requestId: message.requestId,
        command: message.command
      });
      if (!prepared.opId.trim()) throw new Error("prepare returned an empty opId");
      operation.opId = prepared.opId;
      if (this.operationsById.has(prepared.opId)) {
        operation.phase = "failed";
        this.release(operation);
        await this.sendNotStarted(
          message.requestId,
          "DUPLICATE_OPERATION",
          "prepare returned an opId already owned by this capsule",
          prepared.opId
        );
        return;
      }
      this.operationsById.set(prepared.opId, operation);
      if (!this.admissionOpen) {
        operation.phase = "failed";
        this.release(operation);
        await this.sendNotStarted(
          message.requestId,
          "ADMISSION_CLOSED",
          "writer shutdown began before proceed",
          prepared.opId
        );
        return;
      }
      operation.execute = prepared.execute;
      operation.phase = "prepared";
      await this.send({
        ...this.frameBase(),
        kind: "prepared",
        requestId: message.requestId,
        opId: prepared.opId
      });
    } catch (error) {
      if (operation.phase === "preparing") {
        operation.phase = "failed";
        this.release(operation);
        await this.sendNotStarted(message.requestId, "PREPARE_FAILED", error, operation.opId);
      } else if (operation.phase === "prepared") {
        operation.phase = "failed";
        this.release(operation);
        throw error;
      } else {
        throw error;
      }
    } finally {
      await this.maybeCompleteShutdown();
    }
  }

  private async handleProceed(message: Extract<RepoWriteParentMessage, { kind: "proceed" }>): Promise<void> {
    const operation = this.operationsByRequest.get(message.requestId);
    const boundaryError = this.boundaryError(message);
    if (boundaryError) {
      await this.sendRejectedProceed(operation, message.requestId, boundaryError, "proceed rejected by capsule boundary");
      return;
    }
    if (!operation) {
      await this.sendNotStarted(message.requestId, "REQUEST_NOT_FOUND", "no prepared request matches proceed");
      return;
    }
    if (operation.opId !== message.opId) {
      await this.sendRejectedProceed(operation, message.requestId, "OP_ID_MISMATCH", "proceed opId does not match prepared opId");
      return;
    }
    if (operation.phase !== "prepared") {
      await this.sendRepeatedProceed(operation);
      return;
    }

    operation.phase = "proceeding";
    try {
      const receipt = await operation.execute!();
      operation.receipt = receipt;
      operation.phase = "committed";
      this.release(operation);
      await this.sendTerminal(operation);
    } catch (error) {
      operation.phase = "unknown";
      this.release(operation);
      await this.sendUnknown(
        operation.requestId,
        operation.opId!,
        "EXECUTION_OUTCOME_UNKNOWN",
        error
      );
    } finally {
      await this.maybeCompleteShutdown();
    }
  }

  private async handleStatus(message: Extract<RepoWriteParentMessage, { kind: "status" }>): Promise<void> {
    const boundaryError = this.boundaryError(message);
    if (boundaryError) {
      await this.sendNotStarted(message.requestId, boundaryError, "status rejected by capsule boundary", message.opId);
      return;
    }
    if (this.controlRequestIds.has(message.requestId)) {
      await this.sendNotStarted(message.requestId, "DUPLICATE_REQUEST", "duplicate status request", message.opId);
      return;
    }
    this.controlRequestIds.add(message.requestId);
    try {
      const canonical = await this.options.hooks.lookup({
        repoId: this.options.repoId,
        generation: this.options.generation,
        opId: message.opId
      });
      const local = this.operationsById.get(message.opId);
      const state = canonical === "not-found" && local ? publicState(local.phase) : canonical;
      await this.send({
        ...this.frameBase(),
        kind: "status",
        requestId: message.requestId,
        opId: message.opId,
        state
      });
    } catch (error) {
      await this.sendNotStarted(
        message.requestId,
        "STATUS_LOOKUP_FAILED",
        boundedRepoWriteDiagnostic(error),
        message.opId
      );
    }
  }

  private async handleShutdown(message: Extract<RepoWriteParentMessage, { kind: "shutdown" }>): Promise<void> {
    const boundaryError = this.boundaryError(message);
    if (boundaryError) {
      await this.sendNotStarted(message.requestId, boundaryError, "shutdown rejected by capsule boundary");
      return;
    }
    if (this.controlRequestIds.has(message.requestId)) {
      await this.sendNotStarted(message.requestId, "DUPLICATE_REQUEST", "duplicate shutdown request");
      return;
    }
    this.controlRequestIds.add(message.requestId);
    if (this.drained) {
      await this.sendDrained(message.requestId);
      return;
    }
    if (this.shutdownAttempt) {
      await this.sendNotStarted(message.requestId, "SHUTDOWN_IN_PROGRESS", "writer shutdown is already in progress");
      return;
    }

    this.admissionOpen = false;
    const attempt: ShutdownAttempt = {
      requestId: message.requestId,
      token: Symbol(message.requestId),
      timer: setTimeout(() => this.timeoutShutdown(attempt), this.limits.shutdownTimeoutMs),
      completing: false
    };
    attempt.timer.unref?.();
    this.shutdownAttempt = attempt;

    for (const operation of this.operationsByRequest.values()) {
      if (operation.phase !== "prepared") continue;
      operation.phase = "failed";
      this.release(operation);
      await this.sendNotStarted(
        operation.requestId,
        "SHUTDOWN_BEFORE_PROCEED",
        "writer shutdown cancelled a prepared operation before proceed",
        operation.opId
      );
    }
    await this.maybeCompleteShutdown();
  }

  private async sendDuplicateSubmit(operation: HostedOperation): Promise<void> {
    if (operation.opId && ["proceeding", "committed", "unknown"].includes(operation.phase)) {
      await this.sendUnknown(
        operation.requestId,
        operation.opId,
        "DUPLICATE_REQUEST",
        "request already crossed the proceed boundary"
      );
      return;
    }
    await this.sendNotStarted(
      operation.requestId,
      "DUPLICATE_REQUEST",
      "requestId is already admitted",
      operation.opId
    );
  }

  private async sendRejectedProceed(
    operation: HostedOperation | undefined,
    requestId: string,
    code: string,
    diagnostic: string
  ): Promise<void> {
    if (operation?.opId && ["proceeding", "committed", "unknown"].includes(operation.phase)) {
      await this.sendUnknown(requestId, operation.opId, code, diagnostic);
      return;
    }
    await this.sendNotStarted(requestId, code, diagnostic, operation?.opId);
  }

  private async sendRepeatedProceed(operation: HostedOperation): Promise<void> {
    if (operation.phase === "committed" && operation.receipt) {
      await this.sendTerminal(operation);
      return;
    }
    if (operation.phase === "proceeding" || operation.phase === "unknown") {
      await this.sendUnknown(
        operation.requestId,
        operation.opId!,
        "DUPLICATE_PROCEED",
        "operation already crossed the proceed boundary"
      );
      return;
    }
    await this.sendNotStarted(
      operation.requestId,
      operation.phase === "preparing" ? "NOT_PREPARED" : "OPERATION_NOT_PROCEEDABLE",
      "operation is not in prepared state",
      operation.opId
    );
  }

  private async sendTerminal(operation: HostedOperation): Promise<void> {
    await this.send({
      ...this.frameBase(),
      kind: "terminal",
      requestId: operation.requestId,
      opId: operation.opId!,
      outcome: "committed",
      receipt: operation.receipt!
    });
  }

  private async sendNotStarted(
    requestId: string,
    code: string,
    diagnostic: unknown,
    opId?: string
  ): Promise<void> {
    await this.send({
      ...this.frameBase(),
      kind: "failure",
      requestId,
      ...(opId ? { opId } : {}),
      phase: "before-proceed",
      outcome: "not-started",
      replay: "caller-may-retry",
      code,
      diagnostic: safeDiagnostic(diagnostic)
    });
  }

  private async sendUnknown(requestId: string, opId: string, code: string, diagnostic: unknown): Promise<void> {
    await this.send({
      ...this.frameBase(),
      kind: "failure",
      requestId,
      opId,
      phase: "after-proceed",
      outcome: "unknown",
      replay: "forbidden",
      code,
      diagnostic: safeDiagnostic(diagnostic)
    });
  }

  private async sendDrained(requestId: string): Promise<void> {
    await this.send({
      ...this.frameBase(),
      kind: "drained",
      requestId
    });
  }

  private boundaryError(message: RepoWriteParentMessage): string | undefined {
    if (message.repoId !== this.options.repoId) return "REPO_MISMATCH";
    if (message.generation !== this.options.generation) return "STALE_GENERATION";
    return undefined;
  }

  private release(operation: HostedOperation): void {
    if (!operation.admitted) return;
    operation.admitted = false;
    this.activeAdmissions -= 1;
  }

  private hasUnsettledOperations(): boolean {
    for (const operation of this.operationsByRequest.values()) {
      if (operation.phase === "preparing" || operation.phase === "prepared" || operation.phase === "proceeding") {
        return true;
      }
    }
    return false;
  }

  private async maybeCompleteShutdown(): Promise<void> {
    const attempt = this.shutdownAttempt;
    if (!attempt || attempt.completing || this.hasUnsettledOperations()) return;
    attempt.completing = true;
    try {
      await this.shutdownHook();
      if (this.shutdownAttempt?.token !== attempt.token) return;
      clearTimeout(attempt.timer);
      await this.sendDrained(attempt.requestId);
      this.drained = true;
      this.shutdownAttempt = undefined;
    } catch (error) {
      if (this.shutdownAttempt?.token !== attempt.token) return;
      clearTimeout(attempt.timer);
      this.shutdownAttempt = undefined;
      this.shutdownHookPromise = undefined;
      await this.sendNotStarted(
        attempt.requestId,
        "SHUTDOWN_FAILED",
        error
      );
    }
  }

  private shutdownHook(): Promise<void> {
    this.shutdownHookPromise ??= Promise.resolve(this.options.hooks.shutdown({
      repoId: this.options.repoId,
      generation: this.options.generation
    }));
    return this.shutdownHookPromise;
  }

  private timeoutShutdown(attempt: ShutdownAttempt): void {
    if (this.shutdownAttempt?.token !== attempt.token) return;
    this.shutdownAttempt = undefined;
    void this.sendNotStarted(
      attempt.requestId,
      "SHUTDOWN_TIMEOUT",
      `writer did not drain within ${this.limits.shutdownTimeoutMs}ms`
    ).catch(() => undefined);
  }

  private send(message: RepoWriteChildMessage): Promise<void> {
    const write = this.outbound
      .catch(() => undefined)
      .then(() => this.options.transport.send(message));
    this.outbound = write.then(() => undefined, () => undefined);
    return write;
  }

  private frameBase() {
    return {
      protocol: repoWriteProtocolType,
      repoId: this.options.repoId,
      generation: this.options.generation
    } as const;
  }
}

export function createRepoWriteChildHost(options: RepoWriteChildHostOptions): RepoWriteChildHost {
  return new RepoWriteChildHost(options);
}

function publicState(phase: OperationPhase): RepoWriteOperationState {
  if (phase === "preparing" || phase === "prepared") return "prepared";
  if (phase === "proceeding") return "proceeding";
  return phase;
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function safeDiagnostic(value: unknown): string {
  return boundedRepoWriteDiagnostic(typeof value === "string" ? new Error(value) : value);
}
