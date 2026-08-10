import type { DaemonHostCommandResult } from "@harness-anything/application";

export interface BackgroundRuntimeEventFailure {
  readonly requestId: string;
  readonly command: string;
  readonly reason: string;
}

export type DeferredCommandRuntimeEventAppend = () => Promise<DaemonHostCommandResult>;

export class BackgroundCommandRuntimeEventDrain {
  private readonly active = new Set<Promise<void>>();
  private readonly options: {
    readonly onFailure?: (failure: BackgroundRuntimeEventFailure) => void | Promise<void>;
  };

  constructor(options: {
    readonly onFailure?: (failure: BackgroundRuntimeEventFailure) => void | Promise<void>;
  } = {}) {
    this.options = options;
  }

  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active]);
  }

  responseRelease(input: {
    readonly requestId: string;
    readonly command: string;
    readonly releaseAuthoritySettlement: () => void;
    readonly appends: ReadonlyArray<DeferredCommandRuntimeEventAppend>;
  }): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      input.releaseAuthoritySettlement();
      for (const append of input.appends) this.start(input.requestId, input.command, append);
    };
  }

  private start(
    requestId: string,
    command: string,
    append: DeferredCommandRuntimeEventAppend
  ): void {
    const completion = Promise.resolve().then(append).then(
      async (result) => {
        const failure = runtimeEventAppendFailure(result);
        if (failure) await this.reportFailure({ requestId, command, reason: failure });
      },
      async (error) => this.reportFailure({
        requestId,
        command,
        reason: error instanceof Error ? error.message : String(error)
      })
    );
    this.active.add(completion);
    void completion.then(
      () => this.active.delete(completion),
      () => this.active.delete(completion)
    );
  }

  private async reportFailure(failure: BackgroundRuntimeEventFailure): Promise<void> {
    if (this.options.onFailure) {
      try {
        await this.options.onFailure(failure);
        return;
      } catch (error) {
        process.emitWarning(
          `Background runtime-event failure reporting failed for ${failure.requestId}: ${error instanceof Error ? error.message : String(error)}`,
          { code: "RUNTIME_EVENT_FAILURE_REPORTING_FAILED" }
        );
      }
    }
    process.emitWarning(
      `Background runtime-event append failed for ${failure.requestId} (${failure.command}): ${failure.reason}`,
      { code: "RUNTIME_EVENT_APPEND_FAILED" }
    );
  }
}

function runtimeEventAppendFailure(result: DaemonHostCommandResult): string | undefined {
  for (const warning of result.warnings ?? []) {
    if (typeof warning !== "object" || warning === null) continue;
    if ((warning as { readonly code?: unknown }).code !== "runtime_event_append_failed") continue;
    const message = (warning as { readonly message?: unknown }).message;
    return typeof message === "string" ? message : "runtime-event append returned a failure warning";
  }
  return undefined;
}
