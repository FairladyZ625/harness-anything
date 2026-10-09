import path from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { applyLedgerBackupRetention, LedgerBackupRetentionPolicyV1 } from "@harness-anything/kernel";

export interface BackupVerification {
  readonly rootDir: string;
  readonly backupDir: string;
  readonly backupRoot: string;
  readonly now: string;
  readonly policy: LedgerBackupRetentionPolicyV1;
}
export interface BackupVerificationResult {
  readonly reusedSnapshot: boolean;
  readonly bytes: number;
  readonly backupMs: number;
  readonly captureMs: number;
  readonly drillMs: number;
  readonly cleanupMs: number;
  readonly retention: ReturnType<typeof applyLedgerBackupRetention>;
}
export type BackupWorkerMessage =
  | { readonly kind: "prepared" }
  | { readonly kind: "captured" }
  | { readonly kind: "result"; readonly result: BackupVerificationResult };

// A builtin owns physical worker resources, not a renewable Schedule lease. Bound its
// lifetime to 30 minutes (the supplied successful runs took about 8.5 minutes).
export const backupExecutionLimitMs = 30 * 60_000;

/** Only live-source capture holds the writer queue; all validation reads the frozen payload. */
export function finishLedgerBackup(
  input: BackupVerification,
  runSnapshot: <T>(work: () => T | PromiseLike<T>) => Promise<T>,
  spawnWorker: new (url: string | URL, options: WorkerOptions) => Worker = Worker,
): Promise<BackupVerificationResult> {
  const prepared = Promise.withResolvers<void>(),
    captured = Promise.withResolvers<void>(),
    finished = Promise.withResolvers<BackupVerificationResult>(),
    worker = new spawnWorker(
      new URL(`./schedule-builtin-executor${path.extname(import.meta.filename)}`, import.meta.url),
      {
        workerData: { kind: "ledger-backup-verification" },
        execArgv: process.execArgv.filter(
          (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
        ),
      },
    );
  worker.on("message", (message: BackupWorkerMessage) => {
    if (message.kind === "prepared") prepared.resolve();
    else if (message.kind === "captured") captured.resolve();
    // The result settles at once; the worker's own exit must never be the settlement signal.
    else finished.resolve(message.result);
  });
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    prepared.reject(error);
    captured.reject(error);
    finished.reject(error);
  };
  worker.once("error", fail);
  worker.once("exit", (code) => {
    // terminate() after a settled run lands here too; rejecting settled resolvers is a no-op.
    fail(failure ?? new Error(`backup worker exited ${code} without a result`));
  });
  const deadline = setTimeout(() => {
    failure = new Error(`backup worker exceeded ${backupExecutionLimitMs}ms execution limit`);
    // Reject capture only after exit: releasing the writer while a worker can still
    // copy live source would let a later capture overlap an abandoned executor.
    void worker.terminate().catch(fail);
  }, backupExecutionLimitMs);
  deadline.unref?.();
  // Observe every phase from the outset, including failures before capture admission.
  const capture = prepared.promise.then(() =>
    runSnapshot(() => {
      if (failure) throw failure;
      worker.postMessage({ kind: "capture" });
      return captured.promise;
    }),
  );
  worker.postMessage(input);
  return Promise.all([capture, captured.promise, finished.promise])
    .then(([, , result]) => result)
    .finally(() => {
      clearTimeout(deadline);
      return worker.terminate();
    });
}
