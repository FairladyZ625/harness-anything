import type { CommandReceiptEnvelope } from "@harness-anything/application";
import { decodeRepoWriteCommandReceiptV2 } from "./repo-write-command-receipt.ts";
import {
  RepoWriteClient,
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

export interface RepoWriteProcessSupervisorOptions {
  readonly repoId: string;
  readonly generation: number;
  readonly spawn: () => RepoWriteParentProcessTransport;
  readonly onTelemetry?: ConstructorParameters<typeof RepoWriteClient>[0]["onTelemetry"];
}

interface ActiveWriter {
  readonly transport: RepoWriteParentProcessTransport;
  readonly client: RepoWriteClient;
}

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
        return this.recoverExact(error.opId, error);
      }
      if (!(error instanceof RepoWriteNotStartedError)
        || error.opId !== undefined
        || this.writerConnected(writer)) {
        throw error;
      }
      writer = await this.replace(writer);
      try {
        return decodeReceipt(await writer.client.submit(command));
      } catch (retryError) {
        if (retryError instanceof RepoWriteOutcomeUnknownError) {
          return this.recoverExact(retryError.opId, retryError);
        }
        throw retryError;
      }
    }
  }

  async lookup(opId: string): Promise<RepoWriteOperationLookupResult> {
    const writer = await this.current();
    try {
      return await writer.client.lookup(opId);
    } catch (error) {
      if (this.writerConnected(writer)) throw error;
      return (await this.replace(writer)).client.lookup(opId);
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    const writer = this.active;
    if (!writer) return;
    try {
      if (this.writerConnected(writer)) {
        await writer.client.shutdown();
      }
    } finally {
      writer.transport.terminate("SIGTERM");
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
        `Exact repo-write outcome lookup failed for ${opId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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

  private spawn(): Promise<ActiveWriter> {
    if (this.starting) return this.starting;
    const pending = (async () => {
      const transport = this.options.spawn();
      const client = new RepoWriteClient({
        repoId: this.options.repoId,
        generation: this.options.generation,
        transport,
        onTelemetry: this.options.onTelemetry ?? (() => undefined)
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

function decodeReceipt(
  value: Parameters<typeof decodeRepoWriteCommandReceiptV2>[0]
): CommandReceiptEnvelope {
  return decodeRepoWriteCommandReceiptV2(value, "$.repoWriteReceipt");
}
