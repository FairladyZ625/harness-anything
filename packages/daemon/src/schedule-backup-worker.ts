import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { applyLedgerBackupRetention, type LedgerBackupRetentionPolicyV1 } from "@harness-anything/kernel";
import { drillRepoBackup } from "./repo-all-purge.ts";

interface BackupVerification {
  readonly rootDir: string;
  readonly backupDir: string;
  readonly backupRoot: string;
  readonly now: string;
  readonly policy: LedgerBackupRetentionPolicyV1;
}
interface BackupVerificationResult {
  readonly drillMs: number;
  readonly cleanupMs: number;
  readonly retention: ReturnType<typeof applyLedgerBackupRetention>;
}

/** Synchronous restore and deletion IO belongs off the canonical writer's event loop. */
export function finishLedgerBackup(input: BackupVerification): Promise<BackupVerificationResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: "ledger-backup-verification" },
      execArgv: process.execArgv.filter(
        (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
      ),
    });
    let result: BackupVerificationResult | undefined;
    worker.once("message", (value: BackupVerificationResult) => {
      result = value;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error(`backup verification worker exited ${code} without a result`));
    });
    worker.postMessage(input);
  });
}

if (!isMainThread && workerData?.kind === "ledger-backup-verification" && parentPort) {
  parentPort.once("message", (input: BackupVerification) => {
    let phase = "drill";
    try {
      const drillStartedAt = performance.now();
      drillRepoBackup({ rootDir: input.rootDir, backupDir: input.backupDir });
      const drillMs = Math.round(performance.now() - drillStartedAt);
      phase = "cleanup";
      const cleanupStartedAt = performance.now(),
        retention = applyLedgerBackupRetention({
          backupRoot: input.backupRoot,
          now: input.now,
          policy: input.policy,
          protectedDirs: [input.backupDir],
        }),
        cleanupMs = Math.round(performance.now() - cleanupStartedAt);
      parentPort!.postMessage({ drillMs, cleanupMs, retention } satisfies BackupVerificationResult);
      parentPort!.close();
    } catch (error) {
      throw new Error(`ledger-backup ${phase} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  });
}
