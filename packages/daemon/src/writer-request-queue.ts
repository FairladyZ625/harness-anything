import { writerLifecyclePolicy } from "@harness-anything/kernel/internal/domain/writer-lifecycle-policy.ts";

export const REPO_WRITER_QUEUE_LIMIT = writerLifecyclePolicy.defaultValue.queueLimit;

interface WriteSlot {
  readonly state: Int32Array;
  readonly id: number;
  readonly requestId?: string;
  opId: string;
  readonly done: PromiseWithResolvers<void>;
  rollbackTimer?: ReturnType<typeof setTimeout>;
}
interface Request {
  readonly requestId: string;
  readonly opId: string;
  readonly abort: AbortController;
  readonly staged: boolean;
  readonly run: (request: Request) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
  readonly markDispatched: () => void;
  cancel: (reason: unknown) => void;
  cancelled?: unknown;
  dispatched: boolean;
}

/** Admission bounds whole RPCs; the exclusive slot covers only their database write turns. */
export function createWriterRequestQueue(options: {
  readonly repoId: string;
  readonly rollbackGraceMs?: number;
  readonly abortInFlightOnClose?: boolean;
  readonly syncRepDrainGraceMs?: number;
  readonly requestTimeoutMs?: number;
  readonly terminateAborted: (error: Error) => Promise<void>;
  readonly warn?: (warning: { event: string; repoId: string; opId: string }) => void;
}) {
  const pendingQueue: Request[] = [],
    requests = new Map<string, Request>(),
    slotQueue: { requestId?: string; resolve: (slot: WriteSlot) => void; reject: (error: unknown) => void }[] = [];
  let activeWriteSlot: WriteSlot | undefined,
    closed = false,
    sequence = 0;
  const takeSlot = (requestId?: string): WriteSlot => {
    const state = new Int32Array(new SharedArrayBuffer(12)),
      id = (sequence = (sequence + 1) | 0);
    Atomics.store(state, 2, id);
    return (activeWriteSlot = {
      state,
      id,
      requestId,
      opId: (requestId && requests.get(requestId)?.opId) || `writer_turn_${id}`,
      done: Promise.withResolvers<void>(),
    });
  };
  const release = (id: number) => {
    const slot = activeWriteSlot;
    if (!slot || slot.id !== id) return;
    clearTimeout(slot.rollbackTimer);
    Atomics.compareExchange(slot.state, 0, 0, 1);
    Atomics.notify(slot.state, 0);
    activeWriteSlot = undefined;
    slot.done.resolve();
    pump();
  };
  const pump = () => {
    if (activeWriteSlot) return;
    const waiter = slotQueue.shift();
    if (waiter) {
      waiter.resolve(takeSlot(waiter.requestId));
      return;
    }
    if (closed) return;
    while (!activeWriteSlot && pendingQueue.length) {
      const request = pendingQueue.shift()!;
      if (!request.staged) takeSlot(request.requestId);
      void request
        .run(request)
        .then(
          (value) => (request.cancelled !== undefined ? request.reject(request.cancelled) : request.resolve(value)),
          (error: unknown) => request.reject(request.cancelled !== undefined ? request.cancelled : error),
        )
        .finally(() => {
          request.cleanup();
          requests.delete(request.requestId);
          // Unstaged workers hold their slot through the receipt, including detached callers.
          if (activeWriteSlot?.requestId === request.requestId) release(activeWriteSlot.id);
        });
    }
  };
  const cancelSlot = (slot: WriteSlot, reason: unknown) => {
    if (Atomics.load(slot.state, 2) !== slot.id) return;
    const previous = Atomics.compareExchange(slot.state, 1, 0, -1);
    Atomics.notify(slot.state, 0);
    const request = slot.requestId ? requests.get(slot.requestId) : undefined;
    if (previous === 1) {
      // Neither the underlying connection nor the exclusive turn belongs to this caller anymore.
      request?.resolve({
        outcome: "indeterminate",
        code: "publication_indeterminate",
        opId: slot.opId,
        origin: "daemon",
      });
      return;
    }
    request?.abort.abort(reason);
    if (request && !request.dispatched) return;
    slot.rollbackTimer ??= setTimeout(() => {
      if (activeWriteSlot !== slot || Atomics.load(slot.state, 1) !== -1) return;
      void options.terminateAborted(
        queueError("writer_rollback_timeout", "Repository write did not roll back within its grace period"),
      );
    }, options.rollbackGraceMs ?? 5_000);
    slot.rollbackTimer.unref?.();
  };
  return {
    request: <T>(
      requestId: string,
      opId: string,
      signal: AbortSignal | undefined,
      staged: boolean,
      run: (request: Request) => Promise<T>,
    ): Promise<T> => {
      if (closed) return Promise.reject(queueError("daemon_closing", "Repository writer is closed"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (requests.size >= REPO_WRITER_QUEUE_LIMIT)
        return Promise.reject(
          queueError(
            "write_overloaded",
            "Repository writer queue is full while awaiting synchronous replication",
            true,
          ),
        );
      return new Promise<T>((resolve, reject) => {
        let requestTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => request.cancel(signal!.reason),
          request: Request = {
            requestId,
            dispatched: false,
            opId,
            staged,
            run,
            resolve: resolve as (value: unknown) => void,
            reject,
            abort: new AbortController(),
            markDispatched: () => {
              request.dispatched = true;
              if (options.requestTimeoutMs === undefined) return;
              requestTimer = setTimeout(
                () => request.cancel(queueError("writer_request_timeout", "Repository write timed out")),
                options.requestTimeoutMs,
              );
              requestTimer.unref?.();
            },
            cleanup: () => {
              signal?.removeEventListener("abort", onAbort);
              clearTimeout(requestTimer);
            },
            cancel: (reason) => {
              if (!requests.has(requestId) || request.cancelled !== undefined) return;
              request.cancelled = reason;
              const index = pendingQueue.indexOf(request);
              if (index >= 0) {
                pendingQueue.splice(index, 1);
                requests.delete(requestId);
                request.cleanup();
                reject(reason);
                return;
              }
              if (activeWriteSlot?.requestId === requestId) cancelSlot(activeWriteSlot, reason);
              else {
                // Veto later write turns now; the caller still owns its preparation's cleanup receipt.
                request.abort.abort(reason);
                for (const waiter of slotQueue.filter((entry) => entry.requestId === requestId)) {
                  slotQueue.splice(slotQueue.indexOf(waiter), 1);
                  waiter.reject(reason);
                }
              }
            },
          };
        requests.set(requestId, request);
        pendingQueue.push(request);
        signal?.addEventListener("abort", onAbort, { once: true });
        pump();
      });
    },
    acquire: (requestId?: string): Promise<WriteSlot> => {
      if (closed && options.abortInFlightOnClose !== false)
        return Promise.reject(queueError("daemon_closing", "Repository writer is closed"));
      if (requestId) {
        const request = requests.get(requestId);
        if (!request)
          return Promise.reject(queueError("writer_request_inactive", "Repository writer request is no longer active"));
        if (request.cancelled !== undefined) return Promise.reject(request.cancelled);
      }
      if (!activeWriteSlot) return Promise.resolve(takeSlot(requestId));
      return new Promise((resolve, reject) => slotQueue.push({ requestId, resolve, reject }));
    },
    release,
    workerExited: (error: Error) => {
      for (const waiter of slotQueue.splice(0)) waiter.reject(error);
      if (activeWriteSlot) release(activeWriteSlot.id);
    },
    depth: () => requests.size,
    active: () => activeWriteSlot,
    close: async (): Promise<boolean> => {
      closed = true;
      const error = queueError("daemon_closing", "Repository writer is closed");
      if (options.abortInFlightOnClose !== false) for (const waiter of slotQueue.splice(0)) waiter.reject(error);
      const slot = activeWriteSlot;
      for (const request of [...requests.values()]) {
        if (request.dispatched && options.abortInFlightOnClose === false) continue;
        request.cancel(error);
      }
      if (!slot) return true;
      if (options.abortInFlightOnClose === false) {
        await slot.done.promise;
        return true;
      }
      if (!slot.requestId) cancelSlot(slot, error);
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
