import type { RepoWriteChildIpcTransport } from "@harness-anything/daemon";
import type { RetryBudgetSignal } from "@harness-anything/kernel";

export function createRepoWriteRetryBudgetSignalForwarder(input: {
  readonly transport: Pick<RepoWriteChildIpcTransport, "send">;
  readonly repoId: string;
  readonly generation: number;
  readonly formatError: (error: unknown) => string;
}): (signal: RetryBudgetSignal) => void {
  const deliveryFailure = (error: unknown): void => {
    process.emitWarning(
      `Repo-write child could not forward publication retry-budget visibility to the parent daemon: ${input.formatError(error)}`,
      { code: "REPO_WRITE_RETRY_BUDGET_SIGNAL_DELIVERY_FAILED" }
    );
  };
  return (signal) => {
    try {
      void input.transport.send({
        protocol: "harness-repo-write-ipc/v1",
        repoId: input.repoId,
        generation: input.generation,
        kind: "retry-budget-signal",
        phase: signal.phase,
        operation: signal.event.operation,
        cause: input.formatError(signal.event.cause),
        failures: signal.event.failures,
        retriesUsed: signal.event.retriesUsed,
        elapsedMs: signal.event.elapsedMs,
        ...(signal.event.remainingMs === undefined ? {} : {
          remainingMs: signal.event.remainingMs
        })
      }).catch(deliveryFailure);
    } catch (error) {
      deliveryFailure(error);
    }
  };
}
