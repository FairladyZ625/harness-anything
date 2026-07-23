// @slice-activation P5-W2 repo-writer foundation; production composition and durable recovery remain activation work owned by task_01KY6QFFC306JRW8JW4Y2ND2TM.
import {
  type RepoWriteCommandDto,
  type RepoWriteJsonObject,
  type RepoWriteOperationLookupResult,
  type RepoWriteParentMessage
} from "./repo-write-protocol.ts";
import {
  RepoWriteChildResponseWriter,
  type RepoWriteChildTransport
} from "./repo-write-child-response-writer.ts";

export type { RepoWriteChildTransport } from "./repo-write-child-response-writer.ts";

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
  ) => RepoWriteOperationLookupResult | Promise<RepoWriteOperationLookupResult>;
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
  /**
   * Bounds concurrent idempotent status requests and retained shutdown
   * request IDs independently. Status IDs are released after lookup so their
   * capacity can never prevent the drain needed to replace this generation.
   */
  readonly maxControlRequests: number;
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
  cancelledBeforeProceed?: boolean;
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
  maxControlRequests: 16_384,
  shutdownTimeoutMs: 5_000
};

export class RepoWriteChildHost {
  private readonly options: RepoWriteChildHostOptions;
  private readonly limits: RepoWriteChildHostLimits;
  private readonly responses: RepoWriteChildResponseWriter;
  private readonly operationsByRequest = new Map<string, HostedOperation>();
  private readonly operationsById = new Map<string, HostedOperation>();
  private readonly activeStatusRequestIds = new Set<string>();
  private readonly shutdownRequestIds = new Set<string>();
  private activeAdmissions = 0;
  private activeLookups = 0;
  private admissionOpen = true;
  private started = false;
  private starting = false;
  private drained = false;
  private shutdownAttempt: ShutdownAttempt | undefined;
  private shutdownHookPromise: Promise<void> | undefined;

  constructor(options: RepoWriteChildHostOptions) {
    if (!options.repoId.trim()) throw new Error("repoId is required");
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new Error("generation must be a positive safe integer");
    }
    this.options = options;
    this.responses = new RepoWriteChildResponseWriter(options);
    this.limits = {
      maxAdmissions: options.limits?.maxAdmissions ?? defaultLimits.maxAdmissions,
      maxRetainedOperations: options.limits?.maxRetainedOperations ?? defaultLimits.maxRetainedOperations,
      maxControlRequests: options.limits?.maxControlRequests ?? defaultLimits.maxControlRequests,
      shutdownTimeoutMs: options.limits?.shutdownTimeoutMs ?? defaultLimits.shutdownTimeoutMs
    };
    assertPositiveLimit(this.limits.maxAdmissions, "maxAdmissions");
    assertPositiveLimit(this.limits.maxRetainedOperations, "maxRetainedOperations");
    assertPositiveLimit(this.limits.maxControlRequests, "maxControlRequests");
    assertPositiveLimit(this.limits.shutdownTimeoutMs, "shutdownTimeoutMs");
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.starting) throw new Error("repo writer child host start is already in progress");
    this.starting = true;
    this.started = true;
    try {
      await this.responses.ready();
    } catch (error) {
      this.started = false;
      throw error;
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
      await this.responses.notStarted(message.requestId, boundaryError, "submit rejected by capsule boundary");
      return;
    }
    const existing = this.operationsByRequest.get(message.requestId);
    if (existing) {
      await this.sendDuplicateSubmit(existing);
      return;
    }
    if (!this.admissionOpen) {
      await this.responses.notStarted(message.requestId, "ADMISSION_CLOSED", "writer admission is closed");
      return;
    }
    if (this.operationsByRequest.size >= this.limits.maxRetainedOperations) {
      await this.responses.notStarted(
        message.requestId,
        "RETAINED_HISTORY_FULL",
        "writer request history reached its fail-closed generation bound"
      );
      return;
    }
    if (this.activeAdmissions >= this.limits.maxAdmissions) {
      await this.responses.notStarted(message.requestId, "ADMISSION_FULL", "writer admission limit reached");
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
        await this.responses.notStarted(
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
        await this.responses.notStarted(
          message.requestId,
          "ADMISSION_CLOSED",
          "writer shutdown began before proceed",
          prepared.opId
        );
        return;
      }
      operation.execute = prepared.execute;
      operation.phase = "prepared";
      await this.responses.prepared(message.requestId, prepared.opId);
    } catch (error) {
      if (operation.phase === "preparing") {
        operation.phase = "failed";
        this.release(operation);
        await this.responses.notStarted(message.requestId, "PREPARE_FAILED", error, operation.opId);
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
      await this.responses.notStarted(message.requestId, "REQUEST_NOT_FOUND", "no prepared request matches proceed");
      return;
    }
    if (operation.opId !== message.opId) {
      await this.sendRejectedProceed(operation, message.requestId, "OP_ID_MISMATCH", "proceed opId does not match prepared opId");
      return;
    }
    if (!this.admissionOpen && (operation.phase === "prepared" || operation.cancelledBeforeProceed)) {
      if (operation.phase === "prepared") {
        operation.phase = "failed";
        operation.cancelledBeforeProceed = true;
        this.release(operation);
      }
      await this.responses.notStarted(
        operation.requestId,
        "SHUTDOWN_BEFORE_PROCEED",
        "writer shutdown cancelled a prepared operation before proceed",
        operation.opId
      );
      return;
    }
    if (operation.phase !== "prepared") {
      await this.sendRepeatedProceed(operation);
      return;
    }

    operation.phase = "proceeding";
    try {
      let receipt: RepoWriteJsonObject;
      try {
        receipt = await operation.execute!();
      } catch (error) {
        operation.phase = "unknown";
        this.release(operation);
        await this.responses.unknown(
          operation.requestId,
          operation.opId!,
          "EXECUTION_OUTCOME_UNKNOWN",
          error
        );
        return;
      }
      operation.receipt = receipt;
      operation.phase = "committed";
      this.release(operation);
      await this.responses.terminal(operation.requestId, operation.opId!, operation.receipt);
    } finally {
      await this.maybeCompleteShutdown();
    }
  }

  private async handleStatus(message: Extract<RepoWriteParentMessage, { kind: "status" }>): Promise<void> {
    const boundaryError = this.boundaryError(message);
    if (boundaryError) {
      await this.responses.notStarted(message.requestId, boundaryError, "status rejected by capsule boundary", message.opId);
      return;
    }
    if (this.activeStatusRequestIds.has(message.requestId)) {
      await this.responses.notStarted(message.requestId, "DUPLICATE_REQUEST", "duplicate status request", message.opId);
      return;
    }
    if (!this.admissionOpen) {
      await this.responses.notStarted(message.requestId, "ADMISSION_CLOSED", "writer admission is closed", message.opId);
      return;
    }
    if (this.activeStatusRequestIds.size >= this.limits.maxControlRequests) {
      await this.responses.notStarted(
        message.requestId,
        "CONTROL_ADMISSION_FULL",
        "writer status lookup admission reached its fail-closed bound",
        message.opId
      );
      return;
    }
    this.activeStatusRequestIds.add(message.requestId);
    this.activeLookups += 1;
    try {
      const canonical = await this.options.hooks.lookup({
        repoId: this.options.repoId,
        generation: this.options.generation,
        opId: message.opId
      });
      const local = this.operationsById.get(message.opId);
      const result = canonical.state === "not-found" && local
        ? localLookupResult(local)
        : canonical;
      await this.responses.status(message.requestId, message.opId, result);
    } catch (error) {
      await this.responses.notStarted(
        message.requestId,
        "STATUS_LOOKUP_FAILED",
        error,
        message.opId
      );
    } finally {
      this.activeLookups -= 1;
      this.activeStatusRequestIds.delete(message.requestId);
      await this.maybeCompleteShutdown();
    }
  }

  private async handleShutdown(message: Extract<RepoWriteParentMessage, { kind: "shutdown" }>): Promise<void> {
    const boundaryError = this.boundaryError(message);
    if (boundaryError) {
      await this.responses.notStarted(message.requestId, boundaryError, "shutdown rejected by capsule boundary");
      return;
    }
    if (this.shutdownRequestIds.has(message.requestId)) {
      await this.responses.notStarted(message.requestId, "DUPLICATE_REQUEST", "duplicate shutdown request");
      return;
    }
    if (this.shutdownRequestIds.size >= this.limits.maxControlRequests) {
      await this.responses.notStarted(
        message.requestId,
        "SHUTDOWN_HISTORY_FULL",
        "writer shutdown request history reached its fail-closed generation bound"
      );
      return;
    }
    this.shutdownRequestIds.add(message.requestId);
    if (this.drained) {
      await this.responses.drained(message.requestId);
      return;
    }
    if (this.shutdownAttempt) {
      await this.responses.notStarted(message.requestId, "SHUTDOWN_IN_PROGRESS", "writer shutdown is already in progress");
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

    const cancelled: HostedOperation[] = [];
    for (const operation of this.operationsByRequest.values()) {
      if (operation.phase !== "prepared") continue;
      operation.phase = "failed";
      operation.cancelledBeforeProceed = true;
      this.release(operation);
      cancelled.push(operation);
    }
    for (const operation of cancelled) {
      await this.responses.notStarted(
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
      await this.responses.unknown(
        operation.requestId,
        operation.opId,
        "DUPLICATE_REQUEST",
        "request already crossed the proceed boundary"
      );
      return;
    }
    await this.responses.notStarted(
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
      await this.responses.unknown(requestId, operation.opId, code, diagnostic);
      return;
    }
    await this.responses.notStarted(requestId, code, diagnostic, operation?.opId);
  }

  private async sendRepeatedProceed(operation: HostedOperation): Promise<void> {
    if (operation.phase === "committed" && operation.receipt) {
      await this.responses.terminal(operation.requestId, operation.opId!, operation.receipt);
      return;
    }
    if (operation.phase === "proceeding" || operation.phase === "unknown") {
      await this.responses.unknown(
        operation.requestId,
        operation.opId!,
        "DUPLICATE_PROCEED",
        "operation already crossed the proceed boundary"
      );
      return;
    }
    await this.responses.notStarted(
      operation.requestId,
      operation.phase === "preparing" ? "NOT_PREPARED" : "OPERATION_NOT_PROCEEDABLE",
      "operation is not in prepared state",
      operation.opId
    );
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
    if (this.activeLookups > 0) return true;
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
      await this.responses.drained(attempt.requestId);
      this.drained = true;
      this.shutdownAttempt = undefined;
    } catch (error) {
      if (this.shutdownAttempt?.token !== attempt.token) return;
      clearTimeout(attempt.timer);
      this.shutdownAttempt = undefined;
      this.shutdownHookPromise = undefined;
      await this.responses.notStarted(
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
    void this.responses.notStarted(
      attempt.requestId,
      "SHUTDOWN_TIMEOUT",
      `writer did not drain within ${this.limits.shutdownTimeoutMs}ms`
    ).catch(() => undefined);
  }
}

export function createRepoWriteChildHost(options: RepoWriteChildHostOptions): RepoWriteChildHost {
  return new RepoWriteChildHost(options);
}

function localLookupResult(operation: HostedOperation): RepoWriteOperationLookupResult {
  if (operation.phase === "preparing" || operation.phase === "prepared") return { state: "prepared" };
  if (operation.phase === "proceeding") return { state: "proceeding" };
  if (operation.phase !== "committed") return { state: operation.phase };
  if (!operation.receipt) throw new Error("committed repo writer operation is missing its terminal receipt");
  return {
    state: "committed",
    outcome: "committed",
    receipt: operation.receipt
  };
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
