import type { ReplicaDeliveryKey } from "./replica-ack-store.ts";
import type { ReplicaDeliveryLease } from "./replica-delivery-lease.ts";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { openReplicaCutSource, type ReplicaCutSourceOptions, type SnapshotCut } from "./replica-cut-store.ts";

export interface ReplicaCutWorkerInput {
  readonly repoId: string;
  readonly rootDir: string;
  readonly localRoot: string;
  readonly authoredBranch?: string;
}
export type CutRequest = { readonly kind: "activate" };
export interface CutResponse {
  readonly id: number;
  readonly value?: unknown;
  readonly error?: { readonly message: string; readonly code?: string };
}

/** One owner per repository cell, shared by every admitted edge; no connection owns a build. */
export function openReplicaCutWorker(options: ReplicaCutSourceOptions, input: ReplicaCutWorkerInput) {
  const metadata = openReplicaCutSource(options);
  let worker: Worker | null = null,
    nextId = 0,
    failure: Error | null = null,
    closed = false,
    preparing: Promise<SnapshotCut | null> | null = null;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const request = <T>(command: CutRequest): Promise<T> => {
    if (closed || failure) return Promise.reject(failure ?? new Error("replica cut worker is closed"));
    if (!worker) {
      worker = new Worker(new URL(`./replica-cut-executor${path.extname(import.meta.filename)}`, import.meta.url), {
        workerData: input,
        execArgv: process.execArgv.filter(
          (arg) => arg === "--experimental-strip-types" || arg === "--enable-source-maps",
        ),
      });
      worker.on("message", (message: CutResponse) => {
        const row = pending.get(message.id);
        if (!row) return;
        pending.delete(message.id);
        if (message.error) row.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else row.resolve(message.value);
      });
      worker.once("error", fail);
      worker.once("exit", (code) => {
        if (!closed && !failure) fail(new Error(`replica cut worker exited ${code}`));
      });
    }
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      worker!.postMessage({ id, command });
    });
  };
  const prepare = () =>
    (preparing ??= request<SnapshotCut | null>({ kind: "activate" }).finally(() => {
      preparing = null;
    }));
  return {
    ...metadata,
    activate: () => {
      const current = metadata.latest();
      if (!current) void prepare().catch(fail);
      return current;
    },
    prepare,
    kick: () => {
      metadata.kick();
    },
    waitForCut: async (revision: number, signal?: AbortSignal) => {
      if (!metadata.latest()) await prepare();
      return metadata.waitForCut(revision, signal);
    },
    releasePin: (lease: ReplicaDeliveryLease) => {
      metadata.releasePin(lease);
    },
    pin: (key: ReplicaDeliveryKey, holderId: string, from: number | null, quota: number, leaseRoot: string) =>
      metadata.pin(key, holderId, from, quota, leaseRoot),
    // Immutable delivery reads use the metadata connection, never the synchronous builder queue.
    delivery: metadata.delivery,
    close: () => {
      closed = true;
      fail(new Error("replica cut worker is closed"));
      metadata.close();
      if (worker) void worker.terminate().catch(fail);
    },
  };
}
