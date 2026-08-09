export interface RetryBudgetLimits {
  readonly maxRetries?: number;
  readonly maxElapsedMs?: number;
}

export interface RetryBudgetEvent {
  readonly operation: string;
  readonly cause: unknown;
  readonly failures: number;
  readonly retriesUsed: number;
  readonly elapsedMs: number;
  readonly remainingMs?: number;
}

export type RetryBudgetDecision = RetryBudgetEvent & {
  readonly status: "retry-allowed" | "budget-exhausted";
};

export interface BoundedRetryBudget {
  recordFailure(cause: unknown): RetryBudgetDecision;
  reset(): void;
}

export interface BoundedRetryBudgetOptions {
  readonly operation: string;
  readonly budget: RetryBudgetLimits;
  readonly onExhausted: (event: RetryBudgetEvent) => void;
}

export function createBoundedRetryBudget(options: BoundedRetryBudgetOptions): BoundedRetryBudget {
  assertBudget(options.budget);
  let episodeStartedAt: number | undefined;
  let failures = 0;
  let exhaustionReported = false;

  return {
    recordFailure(cause) {
      const now = Date.now();
      episodeStartedAt ??= now;
      failures += 1;
      const elapsedMs = now - episodeStartedAt;
      const retriesUsed = failures - 1;
      const remainingMs = options.budget.maxElapsedMs === undefined
        ? undefined
        : Math.max(0, options.budget.maxElapsedMs - elapsedMs);
      const event: RetryBudgetEvent = {
        operation: options.operation,
        cause,
        failures,
        retriesUsed,
        elapsedMs,
        ...(remainingMs === undefined ? {} : { remainingMs })
      };
      const exhausted = (
        options.budget.maxRetries !== undefined
        && retriesUsed >= options.budget.maxRetries
      ) || (
        options.budget.maxElapsedMs !== undefined
        && elapsedMs >= options.budget.maxElapsedMs
      );
      if (exhausted && !exhaustionReported) {
        exhaustionReported = true;
        options.onExhausted(event);
      }
      return { ...event, status: exhausted ? "budget-exhausted" : "retry-allowed" };
    },
    reset() {
      episodeStartedAt = undefined;
      failures = 0;
      exhaustionReported = false;
    }
  };
}

function assertBudget(budget: RetryBudgetLimits): void {
  if (budget.maxRetries === undefined && budget.maxElapsedMs === undefined) {
    throw new Error("bounded retry requires maxRetries or maxElapsedMs");
  }
  if (budget.maxRetries !== undefined && (!Number.isSafeInteger(budget.maxRetries) || budget.maxRetries < 0)) {
    throw new Error("bounded retry maxRetries must be a non-negative safe integer");
  }
  if (budget.maxElapsedMs !== undefined && (!Number.isFinite(budget.maxElapsedMs) || budget.maxElapsedMs <= 0)) {
    throw new Error("bounded retry maxElapsedMs must be a positive finite number");
  }
}
