// A backup worker body that finishes its verification but never exits: it speaks the real
// protocol (prepared, then captured and result after capture admission) and then holds a timer
// handle, reproducing the incident where settlement waited on an exit that never came.
// Driven by schedule-builtin-executor.test.ts through finishLedgerBackup's worker spawn.
import { parentPort, workerData } from "node:worker_threads";

if (workerData?.kind === "ledger-backup-verification" && parentPort) {
  const port = parentPort;
  port.on("message", (message) => {
    if (message?.kind !== "capture") return;
    port.postMessage({ kind: "captured" });
    port.postMessage({
      kind: "result",
      result: {
        reusedSnapshot: true,
        bytes: 0,
        backupMs: 1,
        captureMs: 1,
        drillMs: 1,
        cleanupMs: 1,
        retention: { removed: [], retained: [], skipped: [], warnings: [] },
      },
    });
    // The handle that keeps this thread alive long after the result is out.
    setInterval(() => {}, 1_000_000);
  });
  port.postMessage({ kind: "prepared" });
}
