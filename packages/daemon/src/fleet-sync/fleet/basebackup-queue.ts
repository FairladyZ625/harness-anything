export interface BaseBackupQueueStatus {
  readonly queuePosition: number;
  readonly estimatedWaitMs: number | null;
}

interface QueueWaiter {
  readonly signal: AbortSignal;
  readonly onQueued: (status: BaseBackupQueueStatus) => void;
  readonly resolve: (release: (completed?: boolean) => void) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

/** FIFO build admission shared by all repositories in one center process. */
export function createBaseBackupQueue(limit: number) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Base backup concurrency must be positive.");
  let active = 0,
    closed = false;
  const waiters: QueueWaiter[] = [],
    closeWaiters: (() => void)[] = [],
    durations: number[] = [],
    closedError = new Error("Base backup queue is closed."),
    finishClose = (): void => {
      if (closed && active === 0) for (const resolve of closeWaiters.splice(0)) resolve();
    },
    estimate = (position: number): number | null => {
      if (durations.length === 0) return null;
      const mean = durations.reduce((total, duration) => total + duration, 0) / durations.length;
      return Math.ceil(position / limit) * Math.ceil(mean);
    },
    updateQueue = (start = 0): void => {
      for (let index = start; index < waiters.length; index += 1)
        waiters[index]!.onQueued({ queuePosition: index + 1, estimatedWaitMs: estimate(index + 1) });
    },
    releaseFactory =
      (startedAt: number) =>
      (completed = false): void => {
        active -= 1;
        if (completed) {
          durations.push(performance.now() - startedAt);
          if (durations.length > 5) durations.shift();
        }
        if (closed) finishClose();
        else pump();
      },
    pump = (): void => {
      while (active < limit && waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal.aborted) {
          waiter.reject(waiter.signal.reason);
          continue;
        }
        active += 1;
        waiter.resolve(releaseFactory(performance.now()));
      }
      updateQueue();
    };
  return {
    close(): Promise<void> {
      if (!closed) {
        closed = true;
        for (const waiter of waiters.splice(0)) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
          waiter.reject(closedError);
        }
      }
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => closeWaiters.push(resolve));
    },
    acquire(
      signal: AbortSignal,
      onQueued: (status: BaseBackupQueueStatus) => void,
    ): Promise<(completed?: boolean) => void> {
      if (closed) return Promise.reject(closedError);
      if (signal.aborted) return Promise.reject(signal.reason);
      if (active < limit && waiters.length === 0) {
        active += 1;
        return Promise.resolve(releaseFactory(performance.now()));
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          signal,
          onQueued,
          resolve,
          reject,
          onAbort: () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
              updateQueue(index);
            }
            signal.removeEventListener("abort", waiter.onAbort);
            reject(signal.reason);
          },
        } satisfies QueueWaiter;
        waiters.push(waiter);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        updateQueue(waiters.length - 1);
      });
    },
  };
}
