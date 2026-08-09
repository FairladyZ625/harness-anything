import type {
  DaemonLogRepoContext,
  DaemonLogService
} from "@harness-anything/application";
import type {
  RepoWriteRetryBudgetSignalFrame
} from "../runtime/repo-write-protocol.ts";
import { createDaemonRetryBudgetSignalSink } from "./daemon-retry-budget-log.ts";

export function createRepoWriteRetryBudgetSignalSink(
  logs: DaemonLogService,
  context: DaemonLogRepoContext
): (frame: RepoWriteRetryBudgetSignalFrame) => void {
  const sink = createDaemonRetryBudgetSignalSink(logs, context);
  return (frame) => sink({
    phase: frame.phase,
    event: {
      operation: frame.operation,
      cause: frame.cause,
      failures: frame.failures,
      retriesUsed: frame.retriesUsed,
      elapsedMs: frame.elapsedMs,
      ...(frame.remainingMs === undefined ? {} : {
        remainingMs: frame.remainingMs
      })
    }
  });
}
