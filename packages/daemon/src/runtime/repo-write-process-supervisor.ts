import type { CommandReceiptEnvelope } from "@harness-anything/application";
import { decodeRepoWriteCommandReceiptV2 } from "./repo-write-command-receipt.ts";
import {
  RepoWriteClient,
  RepoWriteDirectOutcomeUnknownError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError
} from "./repo-write-client.ts";
import type {
  RepoWriteCommandDto,
  RepoWriteOperationLookupResult
} from "./repo-write-protocol.ts";
import type {
  RepoWriteParentProcessTransport
} from "./repo-write-child-process-transport.ts";
import { measureCurrentDaemonRequestPerformancePhase } from "../observability/request-performance.ts";

export interface RepoWriteProcessSupervisorOptions {
  readonly repoId: string;
  readonly generation: number;
  readonly expectedArtifactIdentity?: string;
  readonly spawn: () => RepoWriteParentProcessTransport;
  readonly limits?: ConstructorParameters<typeof RepoWriteClient>[0]["limits"];
  readonly onTelemetry?: ConstructorParameters<typeof RepoWriteClient>[0]["onTelemetry"];
  readonly onDiagnostic?: ConstructorParameters<typeof RepoWriteClient>[0]["onDiagnostic"];
  readonly onRetryBudgetSignal?: ConstructorParameters<typeof RepoWriteClient>[0]["onRetryBudgetSignal"];
  readonly onRequestTimeout?: ConstructorParameters<typeof RepoWriteClient>[0]["onRequestTimeout"];
  readonly onRequestFailure?: ConstructorParameters<typeof RepoWriteClient>[0]["onRequestFailure"];
  readonly onGracefulStopFailure?: (error: unknown) => void | Promise<void>;
}

interface ActiveWriter {
  readonly transport: RepoWriteParentProcessTransport;
  readonly client: RepoWriteClient;
}

export interface RepoWriteProcessSupervisorStopOptions {
  readonly timeoutMs?: number;
}

// Parent runtime drain does not own in-flight child IPC submissions. Without an
// outer stop deadline, retain the client's established graceful-drain window.
const defaultRepoWriteGracefulStopTimeoutMs = 30_000;
const defaultRepoWriteTerminationPhaseTimeoutMs = 2_000;

/**
 * Keeps one child process bound to one repo/writer generation. A submission is
 * retried only when the client proves it was never sent. Once an outer opId is
 * known, recovery is an exact status lookup and never a fresh command replay.
 */
export class RepoWriteProcessSupervisor {
  private readonly options: RepoWriteProcessSupervisorOptions;
  private active: ActiveWriter | undefined;
  private starting: Promise<ActiveWriter> | undefined;
  private closing = false;

  constructor(options: RepoWriteProcessSupervisorOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    await this.current();
  }

  async submit(command: RepoWriteCommandDto): Promise<CommandReceiptEnvelope> {
    let writer = await this.current();
    try {
      return decodeReceipt(await writer.client.submit(command));
    } catch (error) {
      if (error instanceof RepoWriteOutcomeUnknownError) {
        return this.recoverAfterUnknown(writer, error);
      }
      if (error instanceof RepoWriteNotStartedError
        && error.code === "REPO_WRITE_REQUEST_TIMEOUT") {
        await this.replaceForRecovery(writer);
        throw error;
      }
      if (!(error instanceof RepoWriteNotStartedError)
        || error.opId !== undefined
        || this.writerConnected(writer)) {
        throw error;
      }
      writer = await this.replaceForRecovery(writer);
      try {
        return decodeReceipt(await writer.client.submit(command));
      } catch (retryError) {
        if (retryError instanceof RepoWriteOutcomeUnknownError) {
          return this.recoverAfterUnknown(writer, retryError);
        }
        throw retryError;
      }
    }
  }

  /**
   * Executes a pre-cutover non-durable command in the child exactly once.
   * Once the request may have crossed IPC, neither replacement nor lookup can
   * make replay safe, so any uncertain result is returned fail-closed.
   */
  async direct(command: RepoWriteCommandDto): Promise<CommandReceiptEnvelope> {
    const writer = await this.current();
    try {
      return decodeReceipt(await writer.client.direct(command));
    } catch (error) {
      if (error instanceof RepoWriteDirectOutcomeUnknownError
        || !this.writerConnected(writer)) {
        await this.replaceForRecovery(writer).catch(() => undefined);
      }
      throw error;
    }
  }

  async lookup(opId: string): Promise<RepoWriteOperationLookupResult> {
    const writer = await this.current();
    try {
      return await writer.client.lookup(opId);
    } catch (error) {
      if (error instanceof Error
        && "code" in error
        && error.code === "REPO_WRITE_LOOKUP_TIMEOUT") {
        return (await this.replaceForRecovery(writer)).client.lookup(opId);
      }
      if (this.writerConnected(writer)) throw error;
      return (await this.replaceForRecovery(writer)).client.lookup(opId);
    }
  }

  async stop(options: RepoWriteProcessSupervisorStopOptions = {}): Promise<void> {
    this.closing = true;
    const writer = this.active;
    if (!writer) return;
    if (options.timeoutMs !== undefined
      && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("repo writer stop timeout must be a positive safe integer");
    }
    const deadline = options.timeoutMs === undefined
      ? undefined
      : Date.now() + options.timeoutMs;
    let gracefulError: unknown;
    try {
      if (this.writerConnected(writer)) {
        try {
          await writer.client.shutdown({
            timeoutMs: deadline === undefined
              ? defaultRepoWriteGracefulStopTimeoutMs
              : phaseTimeout(deadline, 2)
          });
        } catch (error) {
          gracefulError = error;
        }
      }
      try {
        await writer.transport.terminateAndWait(
          "SIGTERM",
          deadline === undefined
            ? defaultRepoWriteTerminationPhaseTimeoutMs
            : phaseTimeout(deadline, 2)
        );
      } catch (termError) {
        try {
          await writer.transport.terminateAndWait(
            "SIGKILL",
            deadline === undefined
              ? defaultRepoWriteTerminationPhaseTimeoutMs
              : remainingTimeout(deadline)
          );
        } catch (killError) {
          throw new AggregateError(
            [gracefulError, termError, killError].filter((error) => error !== undefined),
            "failed to terminate repo writer child"
          );
        }
      }
      if (gracefulError !== undefined) {
        try {
          await this.options.onGracefulStopFailure?.(gracefulError);
        } catch {
          // A diagnostic observer cannot turn a confirmed child exit into a stop failure.
        }
      }
    } finally {
      if (this.active === writer) this.active = undefined;
    }
  }

  status(): {
    readonly repoId: string;
    readonly generation: number;
    readonly pid?: number;
    readonly connected: boolean;
  } {
    const writer = this.active;
    return {
      repoId: this.options.repoId,
      generation: this.options.generation,
      ...(writer?.transport.child.pid ? { pid: writer.transport.child.pid } : {}),
      connected: writer ? this.writerConnected(writer) : false
    };
  }

  private async recoverExact(
    opId: string,
    original: RepoWriteOutcomeUnknownError
  ): Promise<CommandReceiptEnvelope> {
    let result: RepoWriteOperationLookupResult;
    try {
      result = await this.lookup(opId);
    } catch (error) {
      throw new RepoWriteOutcomeUnknownError(
        "REPO_WRITE_LOOKUP_FAILED",
        `${mostActionableRepoWriteErrorMessage(error)}. Exact repo-write outcome lookup failed for ${opId}; query the stable outer opId ${opId}.`,
        opId
      );
    }
    if (result.state === "committed" || result.state === "rejected") {
      return decodeReceipt(result.receipt);
    }
    throw new RepoWriteOutcomeUnknownError(
      original.code,
      `Repo-write outcome remains ${result.state}; query the stable outer opId ${opId}.`,
      opId
    );
  }

  private async recoverAfterUnknown(
    writer: ActiveWriter,
    error: RepoWriteOutcomeUnknownError
  ): Promise<CommandReceiptEnvelope> {
    if (error.code === "REPO_WRITE_STALL_TIMEOUT") {
      try {
        await this.replaceForRecovery(writer);
      } catch (replacementError) {
        throw new RepoWriteOutcomeUnknownError(
          "REPO_WRITE_LOOKUP_FAILED",
          `Repo-write stall replacement failed for ${error.opId}: ${
            replacementError instanceof Error ? replacementError.message : String(replacementError)
          }`,
          error.opId
        );
      }
    }
    return this.recoverExact(error.opId, error);
  }

  private current(): Promise<ActiveWriter> {
    if (this.closing) {
      return Promise.reject(new Error("REPO_WRITE_SUPERVISOR_CLOSED"));
    }
    if (this.active && this.writerConnected(this.active)) {
      return Promise.resolve(this.active);
    }
    if (this.active) return this.replace(this.active);
    return this.spawn();
  }

  private replace(expected: ActiveWriter): Promise<ActiveWriter> {
    if (this.active === expected) {
      expected.transport.terminate("SIGTERM");
      this.active = undefined;
    }
    return this.spawn();
  }

  private replaceForRecovery(expected: ActiveWriter): Promise<ActiveWriter> {
    return measureCurrentDaemonRequestPerformancePhase(
      "repo-write-recovery",
      () => this.replace(expected)
    );
  }

  private spawn(): Promise<ActiveWriter> {
    if (this.starting) return this.starting;
    const pending = (async () => {
      const transport = this.options.spawn();
      const client = new RepoWriteClient({
        repoId: this.options.repoId,
        generation: this.options.generation,
        transport,
        ...(this.options.expectedArtifactIdentity === undefined ? {} : {
          expectedArtifactIdentity: this.options.expectedArtifactIdentity
        }),
        ...(this.options.limits ? { limits: this.options.limits } : {}),
        onTelemetry: this.options.onTelemetry ?? (() => undefined),
        onDiagnostic: this.options.onDiagnostic,
        onRetryBudgetSignal: this.options.onRetryBudgetSignal,
        onRequestTimeout: this.options.onRequestTimeout,
        onRequestFailure: this.options.onRequestFailure
      });
      const writer = { transport, client };
      this.active = writer;
      try {
        await client.waitUntilReady();
        return writer;
      } catch (error) {
        transport.terminate("SIGTERM");
        if (this.active === writer) this.active = undefined;
        throw error;
      }
    })();
    this.starting = pending;
    void pending.finally(() => {
      if (this.starting === pending) this.starting = undefined;
    }).catch(() => undefined);
    return pending;
  }

  private writerConnected(writer: ActiveWriter): boolean {
    return writer.transport.child.connected
      && writer.transport.child.exitCode === null
      && writer.transport.child.signalCode === null;
  }
}

function phaseTimeout(deadline: number, phasesRemaining: number): number {
  return Math.max(1, Math.floor(remainingTimeout(deadline) / phasesRemaining));
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function decodeReceipt(
  value: Parameters<typeof decodeRepoWriteCommandReceiptV2>[0]
): CommandReceiptEnvelope {
  return decodeRepoWriteCommandReceiptV2(value, "$.repoWriteReceipt");
}

export function mostActionableRepoWriteErrorMessage(error: unknown): string {
  const candidates: string[] = [];
  collectErrorMessages(error, candidates, new Set<unknown>());
  return candidates[0] ?? (error instanceof Error ? error.message : String(error));
}

function collectErrorMessages(value: unknown, candidates: string[], seen: Set<unknown>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return;
    const embedded = parseEmbeddedJson(text);
    if (embedded !== undefined) collectErrorMessages(embedded, candidates, seen);
    else candidates.push(text.replace(/^Error:\s*/u, ""));
    return;
  }
  if (typeof value !== "object") {
    candidates.push(String(value));
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (value instanceof Error) {
    collectErrorMessages(value.cause, candidates, seen);
    collectErrorMessages(value.message, candidates, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["cause", "reason", "message", "hint", "error"]) {
    if (key in record) collectErrorMessages(record[key], candidates, seen);
  }
}

function parseEmbeddedJson(value: string): unknown | undefined {
  const whole = tryParseJson(value);
  if (whole !== undefined) return whole;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "{" && value[index] !== "[") continue;
    const embedded = tryParseJson(value.slice(index));
    if (embedded !== undefined) return embedded;
  }
  return undefined;
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
