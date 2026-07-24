// @slice-activation P5-W2 repo-writer child response boundary owned by task_01KY6QFFC306JRW8JW4Y2ND2TM.
import {
  boundedRepoWriteDiagnostic,
  repoWriteProtocolType,
  type RepoWriteChildMessage,
  type RepoWriteJsonObject,
  type RepoWriteOperationLookupResult,
  type RepoWriteTerminalOutcome
} from "./repo-write-protocol.ts";

export interface RepoWriteChildTransport {
  readonly send: (message: RepoWriteChildMessage) => void | Promise<void>;
}

export interface RepoWriteChildResponseWriterOptions {
  readonly repoId: string;
  readonly generation: number;
  readonly artifactIdentity: string;
  readonly transport: RepoWriteChildTransport;
}

/**
 * Serializes child responses and owns their protocol frame construction.
 * Host lifecycle code supplies semantic outcomes without duplicating wire
 * details or bounded-diagnostic policy.
 */
export class RepoWriteChildResponseWriter {
  private readonly options: RepoWriteChildResponseWriterOptions;
  private outbound = Promise.resolve();

  constructor(options: RepoWriteChildResponseWriterOptions) {
    this.options = options;
  }

  ready(): Promise<void> {
    return this.send({
      ...this.frameBase(),
      kind: "ready",
      artifactIdentity: this.options.artifactIdentity
    });
  }

  prepared(requestId: string, opId: string): Promise<void> {
    return this.send({
      ...this.frameBase(),
      kind: "prepared",
      requestId,
      opId
    });
  }

  status(requestId: string, opId: string, result: RepoWriteOperationLookupResult): Promise<void> {
    return this.send({
      ...this.frameBase(),
      kind: "status",
      requestId,
      opId,
      ...result
    });
  }

  terminal(
    requestId: string,
    opId: string,
    outcome: RepoWriteTerminalOutcome,
    receipt: RepoWriteJsonObject
  ): Promise<void> {
    return this.send({
      ...this.frameBase(),
      kind: "terminal",
      requestId,
      opId,
      outcome,
      receipt
    });
  }

  notStarted(requestId: string, code: string, diagnostic: unknown, opId?: string): Promise<void> {
    return this.send({
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

  unknown(requestId: string, opId: string, code: string, diagnostic: unknown): Promise<void> {
    return this.send({
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

  drained(requestId: string): Promise<void> {
    return this.send({
      ...this.frameBase(),
      kind: "drained",
      requestId
    });
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

function safeDiagnostic(value: unknown): string {
  return boundedRepoWriteDiagnostic(typeof value === "string" ? new Error(value) : value);
}
