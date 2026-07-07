import { Effect } from "effect";
import type { FlushReport, RecoveryReport, WriteCoordinator, WriteError } from "../../../kernel/src/index.ts";

type QueuedWriteOp = Parameters<WriteCoordinator["enqueue"]>[0];

export interface CliDaemonRuntime {
  readonly enqueueInteractiveWrite: (request: {
    readonly commandId: string;
    readonly ops: ReadonlyArray<QueuedWriteOp>;
  }) => Promise<{
    readonly flush: FlushReport;
  }>;
  readonly status: () => {
    readonly lastRecovery?: RecoveryReport;
  };
}

export function makeDaemonQueuedWriteCoordinator(
  runtime: CliDaemonRuntime,
  commandId: string
): WriteCoordinator {
  const pending: Array<QueuedWriteOp> = [];
  return {
    enqueue: (op) => Effect.sync(() => {
      pending.push(op);
      return { opId: op.opId, entityId: op.entityId, accepted: true };
    }),
    flush: (reason) => Effect.tryPromise({
      try: async () => {
        if (pending.length === 0) {
          return { reason, opCount: 0, committed: false };
        }
        const ops = pending.splice(0, pending.length);
        const receipt = await runtime.enqueueInteractiveWrite({
          commandId,
          ops
        });
        return receipt.flush;
      },
      catch: (cause): WriteError => toWriteError(cause)
    }),
    recover: Effect.tryPromise({
      try: async () => runtime.status().lastRecovery ?? { replayedOps: 0 },
      catch: (cause): WriteError => toWriteError(cause)
    })
  };
}

function toWriteError(cause: unknown): WriteError {
  if (isWriteError(cause)) return cause;
  return { _tag: "JournalUnavailable", cause };
}

function isWriteError(error: unknown): error is WriteError {
  return typeof error === "object"
    && error !== null
    && "_tag" in error
    && (
      error._tag === "WriteRejected"
      || error._tag === "WriteConflict"
      || error._tag === "GlobalWriteConflict"
      || error._tag === "JournalUnavailable"
    );
}
