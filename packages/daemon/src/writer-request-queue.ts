export const REPO_WRITER_QUEUE_LIMIT = 64;

interface Slot {
  readonly state: Int32Array;
  readonly id: number;
  opId: string;
  readonly abort: AbortController;
  readonly run: (slot: Slot) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
  readonly done: PromiseWithResolvers<void>;
  cancel: (reason: unknown) => void;
  dispatched: boolean;
  readonly markDispatched: () => void;
  cancelled?: unknown;
}

/** Host admission owns waiting callers separately from the one underlying worker operation. */
export function createWriterRequestQueue(options: {
  readonly repoId: string;
  readonly rollbackGraceMs?: number;
  readonly abortInFlightOnClose?: boolean;
  readonly syncRepDrainGraceMs?: number;
  readonly requestTimeoutMs?: number;
  readonly terminateAborted: (error: Error) => Promise<void>;
  readonly warn?: (warning: { event: string; repoId: string; opId: string }) => void;
}) {
  const pendingQueue: Slot[] = [];
  let inFlight: Slot | undefined,
    closed = false,
    sequence = 0;
  const pump = () => {
    if (closed || inFlight || !pendingQueue.length) return;
    const slot = pendingQueue.shift()!;
    inFlight = slot;
    void slot
      .run(slot)
      .then(
        (value) => (slot.cancelled ? slot.reject(slot.cancelled) : slot.resolve(value)),
        (error: unknown) => slot.reject(slot.cancelled ?? error),
      )
      .finally(() => {
        slot.cleanup();
        Atomics.compareExchange(slot.state, 0, 0, 1);
        Atomics.notify(slot.state, 0);
        inFlight = undefined;
        slot.done.resolve();
        pump();
      });
  };
  return {
    request: <T>(opId: string, signal: AbortSignal | undefined, run: (slot: Slot) => Promise<T>): Promise<T> => {
      if (closed) return Promise.reject(queueError("daemon_closing", "Repository writer is closed"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (pendingQueue.length >= REPO_WRITER_QUEUE_LIMIT)
        return Promise.reject(
          queueError(
            "write_overloaded",
            "Repository writer queue is full while awaiting synchronous replication",
            true,
          ),
        );
      return new Promise<T>((resolve, reject) => {
        const state = new Int32Array(new SharedArrayBuffer(12)),
          id = (sequence = (sequence + 1) | 0),
          abort = new AbortController();
        Atomics.store(state, 2, id);
        let rollbackTimer: ReturnType<typeof setTimeout> | undefined,
          requestTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => slot.cancel(signal!.reason),
          slot: Slot = {
            state,
            dispatched: false,
            markDispatched: () => {
              slot.dispatched = true;
              if (options.requestTimeoutMs === undefined) return;
              requestTimer = setTimeout(
                () => slot.cancel(queueError("writer_request_timeout", "Repository write timed out")),
                options.requestTimeoutMs,
              );
              requestTimer.unref?.();
            },
            id,
            opId,
            abort,
            run,
            resolve: resolve as (value: unknown) => void,
            reject,
            done: Promise.withResolvers<void>(),
            cleanup: () => {
              signal?.removeEventListener("abort", onAbort);
              clearTimeout(rollbackTimer);
              clearTimeout(requestTimer);
            },
            cancel: (reason) => {
              const index = pendingQueue.indexOf(slot);
              if (index >= 0) {
                pendingQueue.splice(index, 1);
                slot.cleanup();
                reject(reason);
                slot.done.resolve();
                return;
              }
              if (inFlight !== slot || Atomics.load(state, 2) !== id) return;
              const previous = Atomics.compareExchange(state, 1, 0, -1);
              Atomics.notify(state, 0);
              if (previous === 1) {
                // The underlying connection and slot outlive the external caller.
                resolve({
                  outcome: "indeterminate",
                  code: "publication_indeterminate",
                  opId: slot.opId,
                  origin: "daemon",
                } as T);
                return;
              }
              slot.cancelled = reason;
              abort.abort(reason);
              if (!slot.dispatched) return;
              rollbackTimer ??= setTimeout(() => {
                if (inFlight !== slot || Atomics.load(state, 1) !== -1) return;
                const error = queueError(
                  "writer_rollback_timeout",
                  "Repository write did not roll back within its grace period",
                );
                void options.terminateAborted(error);
              }, options.rollbackGraceMs ?? 5_000);
              rollbackTimer.unref?.();
            },
          };
        pendingQueue.push(slot);
        signal?.addEventListener("abort", onAbort, { once: true });
        pump();
      });
    },
    depth: () => pendingQueue.length + (inFlight ? 1 : 0),
    active: () => inFlight,
    close: async (): Promise<boolean> => {
      closed = true;
      const error = queueError("daemon_closing", "Repository writer is closed");
      for (const slot of [...pendingQueue]) slot.cancel(error);
      const slot = inFlight;
      if (!slot) return true;
      if (options.abortInFlightOnClose === false) {
        // SQLite has no shared PG commit phase; its already durable batch must finish draining.
        await slot.done.promise;
        return true;
      }
      slot.cancel(error);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        slot.done.promise.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            Atomics.load(slot.state, 1) === 1
              ? (options.syncRepDrainGraceMs ?? 5_000)
              : (options.rollbackGraceMs ?? 5_000),
          );
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (!drained && Atomics.load(slot.state, 1) === 1)
        (options.warn ?? ((warning) => console.warn(JSON.stringify(warning))))({
          event: "writer_close_with_inflight_syncrep",
          repoId: options.repoId,
          opId: slot.opId,
        });
      return drained;
    },
  };
}

function queueError(code: string, message: string, retryable = false): Error {
  return Object.assign(new Error(message), { code, data: { retryable } });
}
