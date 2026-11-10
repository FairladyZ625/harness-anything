import {
  prepareStorageWorkerContext,
  requiresStorageWorkerContext,
  type StorageWorkerContext,
} from "@harness-anything/storage";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { replicaGenerationReaders } from "./fleet/replica-generation.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
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
export const REPO_READ_QUEUE_LIMIT = 64;
export type RepoReadWorkerFactory = (
  url: URL,
  options: {
    readonly execArgv: string[];
    readonly transferList?: import("node:worker_threads").MessagePort[];
    readonly workerData: { readonly storageContext?: StorageWorkerContext } & {
      readonly schema: string;
      readonly protocolVersion: number;
      readonly role: "reader";
      readonly config: RepoReadPayload["config"] & { readonly ownerId: string };
    };
  },
) => Worker;
type Job = {
  readonly createWorker?: RepoReadWorkerFactory;
  readonly owner: object;
  readonly request: RepoWriterRequestV1;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly settled: () => void;
};
type Slot = {
  worker: Worker | null;
  ready: boolean;
  starting: Job | null;
  job: Job | null;
  owner: object | null;
  contextOwner: object | null;
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
  const owner = {},
    outstanding = new Set<Promise<void>>();
  let closed = false;
  return {
    request: <T>(method: string, args: readonly unknown[], binding?: RepoCellBinding): Promise<T> => {
      if (closed) return Promise.reject(readError("repo_unavailable", "Repository reader is closed."));
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
        config: {
          repoId: input.repoId,
          rootDir: input.rootDir,
          storage: input.storage,
          mode: input.mode,
          authoredBranch: input.authoredBranch,
        },
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
        queue.push({
          owner,
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
          settled: () => {
            outstanding.delete(completion);
            settled();
          },
        });
        pump();
      }).finally(() => replicaPin?.release());
    },
    close: async () => {
      closed = true;
      for (let index = queue.length - 1; index >= 0; index--) {
        const job = queue[index]!;
        if (job.owner !== owner) continue;
        queue.splice(index, 1);
        job.reject(readError("repo_unavailable", "Repository reader is closed."));
        job.settled();
      }
      await Promise.all(outstanding);
      // Reserve the idle slots before yielding: another repository must not inherit a worker
      // that is being terminated to release this repository's SQLite/PG handles.
      await Promise.all(slots.filter((slot) => slot.owner === owner && slot.job === null).map(stop));
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
      (slot.contextOwner !== null ||
        requiresStorageWorkerContext((job.request.payload as RepoReadPayload).config.storage))
    ) {
      void stop(slot);
      continue;
    }
    queue.shift();
    slot.job = job;
    slot.owner = job.owner;
    const worker = slot.worker!;
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
    void Promise.resolve()
      .then(() => {
        if (slot.starting !== job || slot.stopping || !queue.includes(job)) return;
        const config = (job.request.payload as RepoReadPayload).config,
          context = prepareStorageWorkerContext(config.storage, config.repoId);
        let worker: Worker;
        try {
          worker = (job.createWorker ?? ((url, options) => new Worker(url, options)))(
            new URL(`./repo-writer-worker${path.extname(import.meta.filename)}`, import.meta.url),
            {
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
        worker.once("exit", context.close);
        // Only transferred physical capabilities bind a worker to its creating client.
        // Other readers already close/reopen their query runtime when config changes.
        slot.contextOwner = context.context === undefined ? null : job.owner;
        slot.worker = worker;
        worker.on("message", (receipt: RepoWriterReceiptV1 | RepoWriterStatusV1) => {
          if (slot.worker !== worker) return;
          if (receipt.schema === "harness-repo-writer-status/v1") {
            if (receipt.kind === "attach-progress") {
              slot.starting = null;
              slot.ready = true;
              pump();
            }
            return;
          }
          const active = slot.job;
          if (!active || receipt.requestId !== active.request.requestId) return;
          slot.job = null;
          if (receipt.outcome === "ok") active.resolve(receipt.value);
          else active.reject(deserializeWriterError(receipt.error!));
          active.settled();
          pump();
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
