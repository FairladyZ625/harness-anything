import {
  createBoundedRetryBudget,
  type RetryBudgetDecision,
  type RetryBudgetEvent,
  type RetryBudgetLimits
} from "@harness-anything/kernel";

export type RetryBudgetSignalPhase = "exhausted" | "still-retrying" | "recovered";

export interface RetryBudgetSignal {
  readonly phase: RetryBudgetSignalPhase;
  readonly event: RetryBudgetEvent;
}

export interface VisibleRetryBudget {
  recordFailure(cause: unknown): RetryBudgetDecision;
  recovered(): void;
}

export function createVisibleRetryBudget(input: {
  readonly operation: string;
  readonly budget: RetryBudgetLimits;
  readonly reminderEveryFailures: number;
  readonly signal?: (signal: RetryBudgetSignal) => void;
}): VisibleRetryBudget {
  if (!Number.isSafeInteger(input.reminderEveryFailures) || input.reminderEveryFailures < 1) {
    throw new Error("retry escalation reminderEveryFailures must be a positive safe integer");
  }
  let escalated = false;
  let lastSignalFailure = 0;
  let lastEvent: RetryBudgetEvent | undefined;
  const retry = createBoundedRetryBudget({
    operation: input.operation,
    budget: input.budget,
    onExhausted: (event) => {
      escalated = true;
      lastSignalFailure = event.failures;
      lastEvent = event;
      input.signal?.({ phase: "exhausted", event });
    }
  });
  return {
    recordFailure(cause) {
      const decision = retry.recordFailure(cause);
      lastEvent = decision;
      if (decision.status === "budget-exhausted"
        && escalated
        && decision.failures - lastSignalFailure >= input.reminderEveryFailures) {
        lastSignalFailure = decision.failures;
        input.signal?.({ phase: "still-retrying", event: decision });
      }
      return decision;
    },
    recovered() {
      if (escalated && lastEvent) input.signal?.({ phase: "recovered", event: lastEvent });
      retry.reset();
      escalated = false;
      lastSignalFailure = 0;
      lastEvent = undefined;
    }
  };
}
