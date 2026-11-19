import { labelWorkerMemory } from "../writer-cell/daemon-diagnostics-memory.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import {
  prepareStorageWorkerContext,
  requiresStorageWorkerContext,
  type StorageWorkerContext,
} from "@harness-anything/storage";
import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { replicaGenerationReaders } from "../fleet-sync/fleet/replica-generation.ts";
import type { RepoCellOpenInput } from "./repo-cell-types.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import {
  REPO_WRITER_PROTOCOL_VERSION,
  deserializeWriterError,
  serializableRepoCellBinding,
  type RepoWriterReceiptV1,
  type RepoWriterStatusV1,
  type RepoWriterRequestV1,
  type RepoReadPayload,
} from "./repo-writer-protocol.ts";

// Process-wide budgets, shared across repositories. A reader owns at most one open repository.
export const REPO_READ_WORKERS = 4;
export const REPO_READ_QUEUE_LIMIT = storageReadPolicy.defaultValue.pageSizes.sessions;
export type RepoReadWorkerFactory = (
  url: URL,
  options: {
    readonly execArgv: string[];
    readonly name?: string;
    readonly transferList?: import("node:worker_threads").MessagePort[];
    readonly workerData: { readonly storageContext?: StorageWorkerContext } & {
      readonly schema: string;
      readonly protocolVersion: number;
      readonly role: "reader";
      readonly config: RepoReadPayload["config"] & { readonly ownerId: string };
    };
  },
) => Worker;
type Owner = { readonly slots: Set<Slot> };
type Job = {
  handoff?: boolean;
  readonly createWorker?: RepoReadWorkerFactory;
  readonly owner: Owner;
  readonly completion: Promise<void>;
  readonly request: RepoWriterRequestV1;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly settled: () => void;
  readonly detachAbort?: () => void;
};
type Slot = {
  worker: Worker | null;
  createWorker?: RepoReadWorkerFactory | typeof Worker;
  ready: boolean;
  starting: Job | null;
  job: Job | null;
  owner: Owner | null;
  contextOwner: Owner | null;
  stopping: Promise<void> | null;
};
const slots: Slot[] = Array.from({ length: REPO_READ_WORKERS }, () => ({
  worker: null,
  ready: false,
  starting: null,
  job: null,
  owner: null,
  contextOwner: null,
  stopping: null,
}));
const queue: Job[] = [];

/** The writer request/receipt envelope carries whole read operations, never callbacks or per-row RPCs. */
export function openRepoReadClient(input: RepoCellOpenInput, createWorker?: RepoReadWorkerFactory) {
  const owner: Owner = { slots: new Set() },
    outstanding = new Set<Promise<void>>(),
    readerId = randomUUID(),
    config: RepoReadPayload["config"] = {
      repoId: input.repoId,
      rootDir: input.rootDir,
      storage: input.storage,
      mode: input.mode,
      authoredBranch: input.authoredBranch,
    };
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    request: <T>(
      method: string,
      args: readonly unknown[],
      binding?: RepoCellBinding,
      signal?: AbortSignal,
    ): Promise<T> => {
      if (closed) return Promise.reject(readError("repo_unavailable", "Repository reader is closed."));
      if (signal?.aborted) return Promise.reject(readAborted());
      if (queue.length >= REPO_READ_QUEUE_LIMIT && slots.every((slot) => slot.job || slot.starting || slot.stopping))
        return Promise.reject(readError("read_overloaded", "Repository read queue is full; retry the read.", true));
      const requestId = randomUUID(),
        now = input.now?.(),
        runtimeInstances = input.runtimeInstances?.();
      // The receiver and collector live on the host. Worker-local Maps cannot protect its files.
      const edgeConfig = input.mode === "remote-edge" ? readFleetEdgeConfig(input.rootDir) : undefined,
        replicaRoot = edgeConfig
          ? path.resolve(edgeConfig.viewRoot, "repos", input.repoId, "views", edgeConfig.nodeId)
          : undefined,
        replicaPin = replicaRoot ? replicaGenerationReaders(replicaRoot).acquire() : null;
      const payload: RepoReadPayload = {
        config,
        readerId,
        method,
        args,
        now,
        runtimeInstances,
        ...(edgeConfig !== undefined
          ? {
              edge: {
                config: edgeConfig,
                ...(replicaRoot ? { pin: { root: replicaRoot, generation: replicaPin?.generation ?? null } } : {}),
              },
            }
          : {}),
      };
      let settled!: () => void;
      const completion = new Promise<void>((resolve) => {
        settled = resolve;
      });
      outstanding.add(completion);
      return new Promise<T>((resolve, reject) => {
        let listener: ReturnType<typeof addAbortListener> | undefined;
        const detachAbort = () => {
          listener?.[Symbol.dispose]();
          listener = undefined;
        };
        const job: Job = {
          owner,
          completion,
          createWorker,
          request: {
            schema: "harness-repo-writer-request/v1",
            protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
            requestId,
            method: "read",
            payload,
            ...(binding ? { binding: serializableRepoCellBinding(binding) } : {}),
            writerEpoch: null,
          },
          resolve: resolve as (value: unknown) => void,
          reject,
          detachAbort,
          settled: () => {
            detachAbort();
            outstanding.delete(completion);
            settled();
          },
        };
        const abort = () => {
          const index = queue.indexOf(job);
          if (index < 0) return;
          queue.splice(index, 1);
          // Release an unstarted reservation. A worker already booting can become a warm reader.
          const reserved = slots.find((slot) => slot.starting === job && slot.worker === null);
          if (reserved) void stop(reserved);
          reject(readAborted(replicaPin?.release));
          job.settled();
        };
        queue.push(job);
        if (signal?.aborted) abort();
        else {
          if (signal) listener = addAbortListener(signal, abort);
          pump();
        }
      }).finally(() => replicaPin?.release());
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      for (let index = queue.length - 1; index >= 0; index--) {
        const job = queue[index]!;
        if (job.owner !== owner) continue;
        queue.splice(index, 1);
        job.reject(readError("repo_unavailable", "Repository reader is closed."));
        job.settled();
      }
      return (closing = (async () => {
        await Promise.all(outstanding);
        // Reserve each idle reader synchronously. A different owner cannot use it until the
        // worker acknowledges that its query runtime has drained all SQLite/PG handles.
        await Promise.all(
          [...owner.slots].map(async (slot) => {
            // A subsequent owner's read may already be switching this worker's runtime.
            // Its receipt (or completed termination) proves our old handles are gone.
            if (slot.job) await slot.job.completion;
            if (slot.stopping) await slot.stopping;
            if (slot.owner === owner)
              await (slot.contextOwner !== null || !slot.ready ? stop(slot) : release(slot, owner, config));
          }),
        );
      })());
    },
  };
}

function pump(): void {
  // A starting worker cannot own work: an already ready reader may become free before its
  // modules finish loading. Keep those jobs in FIFO order until a compatible reader is ready.
  for (const slot of slots) {
    if (!slot.ready || slot.job || slot.stopping || queue.length === 0) continue;
    const job = queue[0]!;
    if (
      slot.owner !== job.owner &&
      (slot.createWorker !== (job.createWorker ?? Worker) ||
        slot.contextOwner !== null ||
        requiresStorageWorkerContext((job.request.payload as RepoReadPayload).config.storage))
    ) {
      void stop(slot);
      continue;
    }
    queue.shift();
    job.detachAbort?.();
    job.handoff = slot.owner !== null && slot.owner !== job.owner;
    slot.job = job;
    slot.owner = job.owner;
    job.owner.slots.add(slot);
    const worker = slot.worker!;
    worker.ref();
    void Promise.resolve()
      .then(() => worker.postMessage(job.request))
      .then(undefined, (error: unknown) => {
        if (slot.worker === worker) fail(slot, error instanceof Error ? error : new Error(String(error)));
      });
  }
  for (const slot of slots) {
    if (slot.worker || slot.starting || slot.stopping) continue;
    const job = queue.find((candidate) => !slots.some((reader) => reader.starting === candidate));
    if (!job) break;
    slot.starting = job;
    slot.owner = job.owner;
    job.owner.slots.add(slot);
    void Promise.resolve()
      .then(() => {
        if (slot.starting !== job || slot.stopping || !queue.includes(job)) return;
        const config = (job.request.payload as RepoReadPayload).config,
          context = prepareStorageWorkerContext(config.storage, config.repoId);
        let worker: Worker;
        try {
          worker = (job.createWorker ?? ((url, options) => new Worker(url, options)))(
            new URL(`./repo-reader-worker${path.extname(import.meta.filename)}`, import.meta.url),
            {
              name: "repo-reader",
              workerData: {
                storageContext: context.context,
                schema: "harness-repo-writer-bootstrap/v1",
                protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
                role: "reader",
                config: { ...(job.request.payload as RepoReadPayload).config, ownerId: "repository-reader" },
              },
              transferList: context.transferList,
              execArgv: process.execArgv.filter(
                (arg) => arg === "--experimental-strip-types" || arg === "--enable-source-maps",
              ),
            },
          );
        } catch (error) {
          context.close();
          throw error;
        }
        labelWorkerMemory(worker, "repo-reader");
        worker.once("exit", context.close);
        // Only transferred physical capabilities bind a worker to its creating client.
        // Other readers already close/reopen their query runtime when config changes.
        slot.contextOwner = context.context === undefined ? null : job.owner;
        slot.worker = worker;
        slot.createWorker = job.createWorker ?? Worker;
        worker.on("message", (receipt: RepoWriterReceiptV1 | RepoWriterStatusV1) => {
          if (slot.worker !== worker) return;
          if (receipt.schema === "harness-repo-writer-status/v1") {
            if (receipt.kind === "attach-progress") {
              slot.starting = null;
              slot.ready = true;
              pump();
              if (!slot.job) worker.unref();
            }
            return;
          }
          const active = slot.job;
          if (!active || receipt.requestId !== active.request.requestId) return;
          slot.job = null;
          if (receipt.outcome === "ok") active.resolve(receipt.value);
          else {
            // A failed handoff may have failed while closing the previous runtime.
            // Only completed termination can then prove its handles were released.
            if (active.handoff) void stop(slot);
            active.reject(deserializeWriterError(receipt.error!));
          }
          active.settled();
          pump();
          if (!slot.job) worker.unref();
        });
        worker.on("error", (error) => {
          if (slot.worker === worker) fail(slot, error);
        });
        worker.on("exit", (code) => {
          if (slot.worker !== worker) return;
          slot.worker = null;
          fail(slot, readError("read_worker_exited", `Repository reader exited (${code}).`));
        });
      })
      .then(undefined, (error: unknown) => fail(slot, error instanceof Error ? error : new Error(String(error))));
  }
}

function release(slot: Slot, owner: Owner, config: RepoReadPayload["config"]): Promise<void> {
  const worker = slot.worker!;
  const completion = Promise.withResolvers<void>();
  const released = new Promise<void>((resolve, reject) => {
    slot.job = {
      owner,
      completion: completion.promise,
      request: {
        schema: "harness-repo-writer-request/v1",
        protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "read",
        payload: { config, method: "close", args: [] } satisfies RepoReadPayload,
        writerEpoch: null,
      },
      resolve: () => resolve(),
      reject: (error) => {
        // Quarantine a failed release before the receipt handler pumps queued reads.
        void stop(slot);
        reject(error);
      },
      settled: () => {
        slot.owner = null;
        completion.resolve();
      },
    };
    worker.ref();
    const request = slot.job.request;
    void Promise.resolve()
      .then(() => worker.postMessage(request))
      .then(undefined, (error: unknown) => {
        if (slot.worker === worker) fail(slot, error instanceof Error ? error : new Error(String(error)));
      });
  });
  return released.catch(async (error: unknown) => {
    await stop(slot);
    throw error;
  });
}

function fail(slot: Slot, error: Error): void {
  const queued = slot.starting ? queue.indexOf(slot.starting) : -1,
    job = slot.job ?? (queued >= 0 ? queue.splice(queued, 1)[0] : null);
  slot.job = null;
  job?.reject(error);
  job?.settled();
  void stop(slot);
}
function stop(slot: Slot): Promise<void> {
  if (slot.stopping) return slot.stopping;
  const worker = slot.worker;
  slot.worker = null;
  slot.ready = false;
  slot.starting = null;
  slot.owner = null;
  slot.contextOwner = null;
  slot.stopping = (worker ? worker.terminate().then(() => undefined) : Promise.resolve()).finally(() => {
    slot.stopping = null;
    pump();
  });
  return slot.stopping;
}
function readError(code: string, message: string, retryable = false): Error {
  return Object.assign(new Error(message), { code, data: { retryable } });
}
function readAborted(releasePin?: () => void): unknown {
  try {
    releasePin?.();
  } catch (error) {
    return error;
  }
  return readError("read_aborted", "Repository read was cancelled before execution.");
}
