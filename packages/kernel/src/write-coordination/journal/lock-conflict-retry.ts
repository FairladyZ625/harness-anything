import { Effect } from "effect";
import type { WriteError } from "../../domain/index.ts";
import { createBoundedRetryBudget } from "../../runtime/bounded-retry.ts";
import type { LockConflictRetryOptions } from "./types.ts";

const defaultRetryInitialDelayMs = 25;
const defaultRetryMaxDelayMs = 250;

export function retryWriteLockConflict<Result>(
  runOnce: () => Effect.Effect<Result, WriteError>,
  retry: LockConflictRetryOptions,
  reconcileDurable?: () => Result | undefined
): Effect.Effect<Result, WriteError> {
  let exhaustedError: WriteError | undefined;
  const budget = createBoundedRetryBudget({
    operation: "journal-write-lock-conflict",
    budget: { maxElapsedMs: retry.maxWaitMs },
    onExhausted: (event) => {
      exhaustedError = lockConflictBudgetExhausted(event.cause as WriteError, retry.maxWaitMs);
    }
  });
  const runAttempt = (attempt: number): Effect.Effect<Result, WriteError> => runOnce().pipe(
    Effect.catchAll((error) => {
      if (!isWriteLockConflict(error)) return Effect.fail(error);
      const reconciled = reconcileDurable?.();
      if (reconciled !== undefined) return Effect.succeed(reconciled);
      const decision = budget.recordFailure(error);
      if (decision.status === "budget-exhausted") {
        return Effect.fail(exhaustedError ?? lockConflictBudgetExhausted(error, retry.maxWaitMs));
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
