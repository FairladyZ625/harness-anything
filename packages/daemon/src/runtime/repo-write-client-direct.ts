import { repoWriteTerminalReceiptMatches } from "./repo-write-terminal-receipt.ts";
import {
  repoWriteProtocolType,
  type RepoWriteCommandDto,
  type RepoWriteDirectFailureFrame,
  type RepoWriteDirectResultFrame,
  type RepoWriteFailureFrame,
  type RepoWriteJsonObject,
  type RepoWriteTelemetryFrame
} from "./repo-write-protocol.ts";
import type { RepoWriteClientTransport } from "./repo-write-client-contract.ts";
import type {
  RepoWriteRequestFailureDiagnostic,
  RepoWriteRequestTimeoutDiagnostic
} from "./repo-write-client-contract.ts";
import {
  observeRepoWriteRequestFailure,
  observeRepoWriteRequestTimeout,
  repoWriteTelemetryTimeoutSuffix
} from "./repo-write-client-timeout.ts";
import {
  RepoWriteDirectOutcomeUnknownError,
  RepoWriteNotStartedError,
  RepoWriteSendDeliveryError
} from "./repo-write-client-errors.ts";

interface PendingDirect {
  readonly requestId: string;
  readonly command: RepoWriteCommandDto;
  readonly resolve: (receipt: RepoWriteJsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  phase: "queued" | "sent";
  lastTelemetry?: RepoWriteTelemetryFrame;
}

export interface RepoWriteDirectClientLaneOptions {
  readonly repoId: string;
  readonly generation: number;
  readonly requestTimeoutMs: number;
  readonly transport: RepoWriteClientTransport;
  readonly failProtocol: (message: string) => void;
  readonly onRequestTimeout?: (diagnostic: RepoWriteRequestTimeoutDiagnostic) => void;
  readonly onRequestFailure?: (
    diagnostic: RepoWriteRequestFailureDiagnostic
  ) => void;
}

export class RepoWriteDirectClientLane {
  private readonly options: RepoWriteDirectClientLaneOptions;
  private readonly pending = new Map<string, PendingDirect>();

  constructor(options: RepoWriteDirectClientLaneOptions) {
    this.options = options;
  }

  get size(): number {
    return this.pending.size;
  }

  submit(
    requestId: string,
    command: RepoWriteCommandDto,
    ready: boolean
  ): Promise<RepoWriteJsonObject> {
    const result = new Promise<RepoWriteJsonObject>((resolve, reject) => {
      const timer = setTimeout(
        () => this.expire(requestId),
        this.options.requestTimeoutMs
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
    if (ready) this.dispatch(requestId);
    return result;
  }

  dispatchAll(): void {
    for (const requestId of this.pending.keys()) this.dispatch(requestId);
  }

  handleResult(message: RepoWriteDirectResultFrame): void {
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.phase !== "sent") {
      this.options.failProtocol("Repo writer direct result does not match a sent request.");
      return;
    }
    const outcome = message.receipt.ok === true ? "committed" : "rejected";
    if (!repoWriteTerminalReceiptMatches(outcome, message.receipt)) {
      this.options.failProtocol("Repo writer direct result is not an exact command receipt.");
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve(message.receipt);
  }

  handleUnknown(message: RepoWriteDirectFailureFrame): void {
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.phase !== "sent") {
      this.options.failProtocol("Repo writer direct failure does not match a sent request.");
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    observeRepoWriteRequestFailure(this.options.onRequestFailure, {
      requestId: message.requestId,
      commandName: pending.command.commandName,
      lane: "direct",
      code: message.code,
      diagnostic: message.diagnostic,
      ...(pending.lastTelemetry ? { lastTelemetry: pending.lastTelemetry } : {})
    });
    pending.reject(new RepoWriteDirectOutcomeUnknownError(message.code, message.diagnostic));
  }

  handleNotStarted(message: RepoWriteFailureFrame): boolean {
    const pending = this.pending.get(message.requestId);
    if (!pending) return false;
    if (pending.phase !== "sent" || message.outcome !== "not-started"
      || message.opId !== undefined) {
      this.options.failProtocol("Repo writer direct rejection has an invalid recovery boundary.");
      return true;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    observeRepoWriteRequestFailure(this.options.onRequestFailure, {
      requestId: message.requestId,
      commandName: pending.command.commandName,
      lane: "direct",
      code: message.code,
      diagnostic: message.diagnostic,
      ...(pending.lastTelemetry ? { lastTelemetry: pending.lastTelemetry } : {})
    });
    pending.reject(new RepoWriteNotStartedError(message.code, message.diagnostic));
    return true;
  }

  disconnect(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(pending.phase === "sent"
        ? new RepoWriteDirectOutcomeUnknownError(
            "CAPSULE_DISCONNECTED",
            `Repo writer disconnected after direct dispatch: ${error.message}`
          )
        : new RepoWriteNotStartedError(
            "CAPSULE_DISCONNECTED",
            `Repo writer disconnected before direct dispatch: ${error.message}`
          ));
    }
  }

  fail(error: Error & { readonly code: string }): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(pending.phase === "sent"
        ? new RepoWriteDirectOutcomeUnknownError(error.code, error.message)
        : new RepoWriteNotStartedError(error.code, error.message));
    }
  }

  rejectQueued(error: Error & { readonly code: string }): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.phase !== "queued") continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new RepoWriteNotStartedError(error.code, error.message));
    }
  }

  telemetryMatches(message: RepoWriteTelemetryFrame): boolean {
    const pending = this.pending.get(message.requestId);
    return pending?.phase === "sent" && message.opId === undefined;
  }

  recordTelemetry(message: RepoWriteTelemetryFrame): void {
    const pending = this.pending.get(message.requestId);
    if (pending?.phase === "sent") pending.lastTelemetry = message;
  }

  private dispatch(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.phase !== "queued") return;
    pending.phase = "sent";
    try {
      const sent = this.options.transport.send({
        protocol: repoWriteProtocolType,
        repoId: this.options.repoId,
        generation: this.options.generation,
        kind: "direct",
        requestId,
        command: pending.command
      });
      void Promise.resolve(sent).catch((error: unknown) =>
        this.rejectSend(requestId, error)
      );
    } catch (error) {
      this.rejectSend(requestId, error, true);
    }
  }

  private expire(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    const diagnostic =
      `Repo writer direct request exceeded its ${this.options.requestTimeoutMs}ms deadline.`
      + repoWriteTelemetryTimeoutSuffix(pending.lastTelemetry);
    observeRepoWriteRequestTimeout(this.options.onRequestTimeout, {
      requestId,
      commandName: pending.command.commandName,
      lane: "direct",
      deadlineMs: this.options.requestTimeoutMs,
      watchdogStage: "deadline",
      ...(pending.lastTelemetry ? { lastTelemetry: pending.lastTelemetry } : {})
    });
    pending.reject(pending.phase === "sent"
      ? new RepoWriteDirectOutcomeUnknownError("REPO_WRITE_DIRECT_TIMEOUT", diagnostic)
      : new RepoWriteNotStartedError("REPO_WRITE_DIRECT_TIMEOUT", diagnostic));
  }

  private rejectSend(requestId: string, error: unknown, synchronous = false): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const message = error instanceof Error ? error.message : String(error);
    const definitelyNotSent = synchronous
      || (error instanceof RepoWriteSendDeliveryError
        && error.delivery === "definitely-not-sent");
    pending.reject(definitelyNotSent
      ? new RepoWriteNotStartedError("CAPSULE_SEND_FAILED", message)
      : new RepoWriteDirectOutcomeUnknownError("CAPSULE_SEND_FAILED", message));
  }
}
