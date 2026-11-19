import { setTimeout as delay } from "node:timers/promises";

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** The callers declare retryable outcomes and a bounded delay, and own the operation identity. */
export async function runDaemonRetry<T>(options: {
  readonly request: () => Promise<T>;
  readonly retryDelay: (settled: Attempt<T>, attempt: number) => number | null;
  readonly signal?: AbortSignal;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const settled = await raceLifetime(options.request(), options.signal).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const next = options.retryDelay(settled, attempt);
    if (next === null) {
      if (settled.ok) return settled.value;
      throw settled.error;
    }
    try {
      await delay(next, undefined, options.signal ? { signal: options.signal } : {});
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      throw error;
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}

/** A request that ignores cancellation cannot extend its caller's lifetime. */
export function raceLifetime<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
