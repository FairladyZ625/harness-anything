import { Effect } from "effect";
import type { WriteError } from "../../domain/index.ts";
import {
  createVisibleRetryBudget,
  type RetryBudgetSignal
} from "../../runtime/bounded-retry.ts";
import type { LockConflictRetryOptions } from "./types.ts";

const defaultRetryInitialDelayMs = 25;
const defaultRetryMaxDelayMs = 250;

export function retryWriteLockConflict<Result>(
  runOnce: () => Effect.Effect<Result, WriteError>,
  retry: LockConflictRetryOptions,
  reconcileDurable?: () => Result | undefined,
  escalation: {
    readonly indeterminateAfterExhaustion?: (error: WriteError) => Result | undefined;
    readonly signal?: (signal: RetryBudgetSignal) => void;
  } = {}
): Effect.Effect<Result, WriteError> {
  const budget = createVisibleRetryBudget({
    operation: "journal-write-lock-conflict",
    budget: { maxElapsedMs: retry.maxWaitMs },
    reminderEveryFailures: retry.reminderEveryFailures ?? 5,
    ...(escalation.signal ? { signal: escalation.signal } : {})
  });
  const runAttempt = (attempt: number): Effect.Effect<Result, WriteError> => runOnce().pipe(
    Effect.map((result) => {
      budget.recovered();
      return result;
    }),
    Effect.catchAll((error) => {
      if (!isWriteLockConflict(error)) return Effect.fail(error);
      const reconciled = reconcileDurable?.();
      if (reconciled !== undefined) {
        budget.recovered();
        return Effect.succeed(reconciled);
      }
      const decision = budget.recordFailure(error);
      if (decision.status === "budget-exhausted") {
        const indeterminate = escalation.indeterminateAfterExhaustion?.(error);
        return indeterminate === undefined
          ? Effect.fail(lockConflictBudgetExhausted(error, retry.maxWaitMs))
          : Effect.succeed(indeterminate);
      }
      const delayMs = Math.min(
        decision.remainingMs ?? retry.maxWaitMs,
        retry.maxDelayMs ?? defaultRetryMaxDelayMs,
        (retry.initialDelayMs ?? defaultRetryInitialDelayMs) * (2 ** attempt)
      );
      return delay(delayMs).pipe(
        Effect.flatMap(() => runAttempt(attempt + 1))
      );
    })
  );
  return runAttempt(0);
}

export function isWriteLockConflict(error: WriteError): boolean {
  return error._tag === "GlobalWriteConflict" || error._tag === "WriteConflict";
}

function lockConflictBudgetExhausted(error: WriteError, maxWaitMs: number): WriteError {
  const suggestion = `automatic retry budget exhausted after ${maxWaitMs}ms; the holder may be committing, so wait briefly and retry the command, or inspect the current lock holder before retrying`;
  if (error._tag === "WriteConflict") {
    return { ...error, owner: `${error.owner ?? "task write lock"}; ${suggestion}` };
  }
  if (error._tag === "GlobalWriteConflict") {
    return { ...error, owner: `${error.owner ?? "global write lock"}; ${suggestion}` };
  }
  return error;
}

function delay(delayMs: number): Effect.Effect<void> {
  return Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, delayMs)));
}
