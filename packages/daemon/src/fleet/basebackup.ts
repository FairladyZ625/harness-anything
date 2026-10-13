import { Worker } from "node:worker_threads";
import path from "node:path";
import type { ReplicationPosition } from "@harness-anything/kernel";

export interface BaseBackupMetadata {
  readonly schema: "fleet-basebackup/v2";
  readonly repoId: string;
  readonly position: ReplicationPosition;
  readonly ledgerGeneration: number;
  readonly projectionSchema: number;
}
export interface BaseBackupArchive {
  readonly metadata: BaseBackupMetadata;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
}
export interface BaseBackupInput {
  readonly ledgerPath: string;
  readonly projectionPath: string;
  readonly directory: string;
}

/** Call under the repo writer/projection barrier; release it once this resolves, not after complete. */
export function startBaseBackup(
  input: BaseBackupInput,
  signal?: AbortSignal,
): Promise<{
  readonly metadata: BaseBackupMetadata;
  readonly complete: Promise<BaseBackupArchive>;
}> {
  let pinned = false;
  let resolveComplete!: (archive: BaseBackupArchive) => void;
  let rejectComplete!: (error: Error) => void;
  const complete = new Promise<BaseBackupArchive>((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });
  // Handlers and captured state exist before the worker can report its first message.
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL(`./basebackup-worker${path.extname(import.meta.filename)}`, import.meta.url), {
      workerData: input,
    });
    const abort = () => {
      void worker.terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const fail = (error: Error) => {
      if (pinned) rejectComplete(error);
      else reject(error);
    };
    let completed = false;
    worker.on(
      "message",
      (
        message: { kind: "pinned"; metadata: BaseBackupMetadata } | { kind: "complete"; archive: BaseBackupArchive },
      ) => {
        if (message.kind === "pinned") {
          pinned = true;
          resolve({ metadata: message.metadata, complete });
        } else {
          completed = true;
          resolveComplete(message.archive);
        }
      },
    );
    worker.on("error", fail);
    worker.on("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (!completed) fail(new Error(`base backup worker exited before completion (${code})`));
    });
  });
}
