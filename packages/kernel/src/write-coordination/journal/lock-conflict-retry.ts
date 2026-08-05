import { Effect } from "effect";
import type { WriteError } from "../../domain/index.ts";
import type { LockConflictRetryOptions } from "./types.ts";

const defaultRetryInitialDelayMs = 25;
const defaultRetryMaxDelayMs = 250;

export function retryWriteLockConflict<Result>(
  runOnce: () => Effect.Effect<Result, WriteError>,
  retry: LockConflictRetryOptions,
  startedAt: number,
  attempt: number,
  reconcileDurable?: () => Result | undefined,
  shouldContinueAfterTimeout?: (error: WriteError) => boolean
): Effect.Effect<Result, WriteError> {
  return runOnce().pipe(
    Effect.catchAll((error) => {
      if (!isWriteLockConflict(error)) return Effect.fail(error);
      const reconciled = reconcileDurable?.();
      if (reconciled !== undefined) return Effect.succeed(reconciled);
      const remainingMs = retry.maxWaitMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        if (!shouldContinueAfterTimeout?.(error)) {
          return Effect.fail(lockConflictTimeout(error, retry.maxWaitMs));
        }
        const delayMs = retry.maxDelayMs ?? defaultRetryMaxDelayMs;
        return delay(delayMs).pipe(
          Effect.flatMap(() => retryWriteLockConflict(
            runOnce,
            retry,
            Date.now(),
            0,
            reconcileDurable,
            shouldContinueAfterTimeout
          ))
        );
      }
      const delayMs = Math.min(
        remainingMs,
        retry.maxDelayMs ?? defaultRetryMaxDelayMs,
        (retry.initialDelayMs ?? defaultRetryInitialDelayMs) * (2 ** attempt)
      );
      return delay(delayMs).pipe(
        Effect.flatMap(() => retryWriteLockConflict(
          runOnce,
          retry,
          startedAt,
          attempt + 1,
          reconcileDurable,
          shouldContinueAfterTimeout
        ))
      );
    })
  );
}

export function isWriteLockConflict(error: WriteError): boolean {
  return error._tag === "GlobalWriteConflict" || error._tag === "WriteConflict";
}

function lockConflictTimeout(error: WriteError, maxWaitMs: number): WriteError {
  const suggestion = `timed out after ${maxWaitMs}ms; the holder may be committing, so retry the command or use the daemon-backed client when a daemon owns the lock`;
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
