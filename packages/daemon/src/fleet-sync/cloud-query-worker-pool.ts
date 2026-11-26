import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { PgProjectionScope } from "../../../storage/src/pg/pg-task-event-materialize.ts";
import type { CloudQueryWorkerRequest, CloudQueryWorkerResponse, SerializedWorkerError } from "./cloud-query-worker.ts";

export interface CloudQueryWorkerDispatch {
  readonly routeName: string;
  readonly repoId: string;
  readonly scope: PgProjectionScope;
  readonly connectionString: string;
  readonly search: string;
  readonly personId: string;
  readonly statelessRoot: string;
  readonly timeoutMs: number;
}

export interface CloudQueryWorkerPoolOptions {
  readonly maxWorkers: number;
  readonly maxReadersPerWorker: number;
  readonly idleTimeoutMs: number;
  readonly makeFault: (status: number, code: string) => Error;
  readonly onError?: (error: unknown) => void;
}

export interface CloudQueryWorkerPool {
  readonly query: (request: CloudQueryWorkerDispatch, signal: AbortSignal) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

interface WorkerSlot {
  readonly worker: Worker;
  busy: boolean;
  exited: boolean;
  closing: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  readonly exitPromise: Promise<number>;
}

interface QueuedWaiter {
  readonly resolve: (slot: WorkerSlot) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

class WorkerPoolError extends Error {
  readonly code?: string;

  constructor(message: string, name = "Error", code?: string) {
    super(message);
    this.name = name;
    if (code !== undefined) this.code = code;
  }
}

/**
 * Bounded async worker pool for reader-backed cloud query routes.
 * Main thread HTTP event loop never calls Atomics.wait; aborted/timed-out workers
 * are terminated immediately so hung SQL calls never poison the pool or leak threads.
 */
export function createCloudQueryWorkerPool(options: CloudQueryWorkerPoolOptions): CloudQueryWorkerPool {
  const slots = new Set<WorkerSlot>();
  const idle: WorkerSlot[] = [];
  const waiters: QueuedWaiter[] = [];
  const closeWaitMs = storageReadPolicy.defaultValue.backoff.followerMaximum;
  let nextRequestId = 0;
  let closed = false;
  let closingPromise: Promise<void> | undefined;

  const clearIdleTimer = (slot: WorkerSlot): void => {
    if (slot.idleTimer !== null) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  };

  const removeFromIdle = (slot: WorkerSlot): void => {
    const index = idle.indexOf(slot);
    if (index >= 0) idle.splice(index, 1);
  };

  const dropSlot = (slot: WorkerSlot): void => {
    slots.delete(slot);
  };

  const stopSlotWorker = (slot: WorkerSlot): Promise<number> =>
    slot.exited ? slot.exitPromise : slot.worker.terminate();

  const terminateSlot = async (slot: WorkerSlot): Promise<void> => {
    slot.closing = true;
    clearIdleTimer(slot);
    removeFromIdle(slot);
    dropSlot(slot);
    await stopSlotWorker(slot);
    await slot.exitPromise;
  };

  const closeSlotGracefully = async (slot: WorkerSlot): Promise<void> => {
    if (slot.closing || slot.exited || slot.busy) {
      await terminateSlot(slot);
      return;
    }
    slot.closing = true;
    clearIdleTimer(slot);
    removeFromIdle(slot);
    dropSlot(slot);
    const id = ++nextRequestId;
    const message: CloudQueryWorkerRequest = { id, op: "close" };
    let fallback: ReturnType<typeof setTimeout> | null = null;
    try {
      slot.worker.postMessage(message);
      fallback = setTimeout(() => {
        void stopSlotWorker(slot);
      }, closeWaitMs);
      fallback.unref();
      await slot.exitPromise;
    } finally {
      if (fallback !== null) clearTimeout(fallback);
      if (!slot.exited) await stopSlotWorker(slot);
    }
  };

  const spawnSlot = (): WorkerSlot => {
    const worker = new Worker(new URL(`./cloud-query-worker${extname(import.meta.filename)}`, import.meta.url), {
      workerData: { maxReaders: options.maxReadersPerWorker },
      execArgv: process.execArgv.filter(
        (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
      ),
    });
    worker.unref();
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const slot: WorkerSlot = {
      worker,
      busy: false,
      exited: false,
      closing: false,
      idleTimer: null,
      exitPromise,
    };
    worker.on("exit", (code) => {
      slot.exited = true;
      clearIdleTimer(slot);
      removeFromIdle(slot);
      dropSlot(slot);
      resolveExit(code);
    });
    worker.on("error", (error) => {
      options.onError?.(error);
      slot.closing = true;
      clearIdleTimer(slot);
      removeFromIdle(slot);
      dropSlot(slot);
    });
    slots.add(slot);
    return slot;
  };

  const armIdleTimer = (slot: WorkerSlot): void => {
    clearIdleTimer(slot);
    if (closed || slot.closing || slot.exited) return;
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      if (!slot.busy && !slot.closing && !slot.exited) void closeSlotGracefully(slot);
    }, options.idleTimeoutMs);
    slot.idleTimer.unref();
  };

  const pumpWaiters = (): void => {
    while (waiters.length > 0 && !closed) {
      let slot = idle.pop();
      while (slot && (slot.exited || slot.closing)) slot = idle.pop();
      if (!slot && slots.size < options.maxWorkers) slot = spawnSlot();
      if (!slot) return;
      const waiter = waiters.shift()!;
      waiter.cleanup();
      clearIdleTimer(slot);
      slot.busy = true;
      waiter.resolve(slot);
    }
  };

  const releaseSlot = (slot: WorkerSlot): void => {
    slot.busy = false;
    if (closed || slot.closing || slot.exited) {
      void closeSlotGracefully(slot);
      pumpWaiters();
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter.cleanup();
      slot.busy = true;
      waiter.resolve(slot);
      return;
    }
    idle.push(slot);
    armIdleTimer(slot);
  };

  const acquireSlot = (signal: AbortSignal): Promise<WorkerSlot> => {
    if (closed) return Promise.reject(options.makeFault(503, "query_store_unavailable"));
    if (signal.aborted) return Promise.reject(signal.reason);
    while (idle.length > 0) {
      const slot = idle.pop()!;
      if (slot.exited || slot.closing) continue;
      clearIdleTimer(slot);
      slot.busy = true;
      return Promise.resolve(slot);
    }
    if (slots.size < options.maxWorkers) {
      const slot = spawnSlot();
      slot.busy = true;
      return Promise.resolve(slot);
    }
    return new Promise<WorkerSlot>((resolve, reject) => {
      const onAbort = () => {
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason);
      };
      const entry: QueuedWaiter = {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiters.push(entry);
    });
  };

  const restoreWorkerError = (error: SerializedWorkerError): Error => {
    if (error.status !== undefined && error.code !== undefined) return options.makeFault(error.status, error.code);
    return new WorkerPoolError(error.message, error.name, error.code);
  };

  const query = async (dispatch: CloudQueryWorkerDispatch, signal: AbortSignal): Promise<unknown> => {
    const slot = await acquireSlot(signal);
    if (closed || signal.aborted) {
      releaseSlot(slot);
      if (signal.aborted) throw signal.reason;
      throw options.makeFault(503, "query_store_unavailable");
    }
    const id = ++nextRequestId;
    let settled = false;
    let detach = () => {};
    return await new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        slot.worker.off("message", onMessage);
        slot.worker.off("error", onError);
        slot.worker.off("exit", onExit);
        signal.removeEventListener("abort", onAbort);
      };
      detach = cleanup;
      const onMessage = (message: CloudQueryWorkerResponse) => {
        if (settled || message.id !== id) return;
        settled = true;
        cleanup();
        releaseSlot(slot);
        if (message.ok) resolve(message.value);
        else reject(restoreWorkerError(message.error));
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        void terminateSlot(slot).finally(pumpWaiters);
        reject(error);
      };
      const onExit = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        dropSlot(slot);
        pumpWaiters();
        reject(
          closed
            ? options.makeFault(503, "query_store_unavailable")
            : new WorkerPoolError(`Cloud query worker exited (${code})`, "Error", "pg_query_worker_exited"),
        );
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        void terminateSlot(slot).finally(() => {
          pumpWaiters();
          reject(signal.reason);
        });
      };

      slot.worker.on("message", onMessage);
      slot.worker.on("error", onError);
      slot.worker.on("exit", onExit);
      signal.addEventListener("abort", onAbort, { once: true });

      const request: CloudQueryWorkerRequest = {
        id,
        op: "query",
        routeName: dispatch.routeName,
        repoId: dispatch.repoId,
        scope: dispatch.scope,
        connectionString: dispatch.connectionString,
        search: dispatch.search,
        personId: dispatch.personId,
        statelessRoot: dispatch.statelessRoot,
        timeoutMs: dispatch.timeoutMs,
      };
      slot.worker.postMessage(request);
    }).catch((error: unknown) => {
      if (!settled) {
        settled = true;
        detach();
        void terminateSlot(slot).finally(pumpWaiters);
      }
      throw error;
    });
  };

  const close = (): Promise<void> =>
    (closingPromise ??= (async () => {
      closed = true;
      const pendingWaiters = waiters.splice(0, waiters.length);
      for (const waiter of pendingWaiters) {
        waiter.cleanup();
        waiter.reject(options.makeFault(503, "query_store_unavailable"));
      }
      const activeSlots = [...slots];
      await Promise.allSettled(activeSlots.map((slot) => closeSlotGracefully(slot)));
    })());

  return { query, close };
}
