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
    readonly workerData: {
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
type Slot = { worker: Worker | null; job: Job | null; owner: object | null; stopping: Promise<void> | null };
const slots: Slot[] = Array.from({ length: REPO_READ_WORKERS }, () => ({
  worker: null,
  job: null,
  owner: null,
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
      if (queue.length >= REPO_READ_QUEUE_LIMIT && slots.every((slot) => slot.job || slot.stopping))
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
  for (const slot of slots) {
    if (slot.job || slot.stopping || queue.length === 0) continue;
    const job = queue.shift()!;
    slot.job = job;
    slot.owner = job.owner;
    void Promise.resolve()
      .then(() => {
        if (!slot.worker) {
          const worker = (job.createWorker ?? ((url, options) => new Worker(url, options)))(
            new URL(`./repo-writer-worker${path.extname(import.meta.filename)}`, import.meta.url),
            {
              workerData: {
                schema: "harness-repo-writer-bootstrap/v1",
                protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
                role: "reader",
                config: { ...(job.request.payload as RepoReadPayload).config, ownerId: "repository-reader" },
              },
              execArgv: process.execArgv.filter(
                (arg) => arg === "--experimental-strip-types" || arg === "--enable-source-maps",
              ),
            },
          );
          slot.worker = worker;
          worker.on("message", (receipt: RepoWriterReceiptV1) => {
            const active = slot.job;
            if (!active || receipt.requestId !== active.request.requestId) return;
            slot.job = null;
            if (receipt.outcome === "ok") active.resolve(receipt.value);
            else active.reject(deserializeWriterError(receipt.error!));
            active.settled();
            pump();
          });
          worker.on("error", (error) => fail(slot, error));
          worker.on("exit", (code) => {
            if (slot.worker !== worker) return;
            slot.worker = null;
            fail(slot, readError("read_worker_exited", `Repository reader exited (${code}).`));
          });
        }
        slot.worker.postMessage(job.request);
      })
      .then(undefined, (error: unknown) => fail(slot, error instanceof Error ? error : new Error(String(error))));
  }
}

function fail(slot: Slot, error: Error): void {
  const job = slot.job;
  slot.job = null;
  job?.reject(error);
  job?.settled();
  void stop(slot);
}
function stop(slot: Slot): Promise<void> {
  if (slot.stopping) return slot.stopping;
  const worker = slot.worker;
  slot.worker = null;
  slot.owner = null;
  slot.stopping = (worker ? worker.terminate().then(() => undefined) : Promise.resolve()).finally(() => {
    slot.stopping = null;
    pump();
  });
  return slot.stopping;
}
function readError(code: string, message: string, retryable = false): Error {
  return Object.assign(new Error(message), { code, data: { retryable } });
}
