import type { DaemonLogRepoContext, DaemonLogService } from "@harness-anything/application";
import type { RetryBudgetSignal } from "./visible-retry-budget.ts";

export function createDaemonRetryBudgetSignalSink(
  logs: DaemonLogService,
  context: DaemonLogRepoContext
): (signal: RetryBudgetSignal) => void {
  return (signal) => {
    const ongoing = signal.phase !== "recovered";
    const event = signal.event;
    const cause = event.cause instanceof Error ? event.cause.message : String(event.cause);
    void logs.append({
      level: ongoing ? "error" : "info",
      source: "daemon",
      component: "retry-budget",
      event: `retry-budget.${signal.phase}`,
      message: ongoing
        ? `${event.operation} ${signal.phase === "exhausted" ? "exhausted its automatic retry budget" : "remains in escalated recovery"}; retriesUsed=${event.retriesUsed}; elapsedMs=${event.elapsedMs}; lastError=${cause}`
        : `${event.operation} recovered after retry-budget escalation; retriesUsed=${event.retriesUsed}; elapsedMs=${event.elapsedMs}`,
      ...(ongoing ? {
        errorCode: "RETRY_BUDGET_EXHAUSTED",
        hint: "Automatic recovery remains active; inspect the upstream dependency and continue monitoring ha daemon logs --errors."
      } : {})
    }, context).catch(() => undefined);
  };
}
