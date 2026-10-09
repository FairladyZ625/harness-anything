// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { finishLedgerBackup } from "../src/schedule-backup-worker.ts";

const limitMs = 30 * 60_000;
const input = {
  rootDir: "/tmp/backup-lifetime-fixture",
  backupDir: "/tmp/backup-lifetime-fixture/snapshot",
  backupRoot: "/tmp/backup-lifetime-fixture",
  now: "2026-10-09T00:00:00Z",
  policy: { keepDays: 3, keepMonthly: true },
};
for (const phase of ["prepare", "capture", "verification"] as const) {
  test(`a frozen backup ${phase} terminates before capture release and completion`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stopped = Promise.withResolvers<number>();
    class FrozenWorker extends EventEmitter {
      static instances: FrozenWorker[] = [];
      terminates = 0;
      constructor() {
        super();
        FrozenWorker.instances.push(this);
      }
      postMessage() {}
      terminate() {
        this.terminates++;
        return stopped.promise;
      }
    }
    let captureFinished = false;
    const pending = finishLedgerBackup(
      input,
      async (work) => {
        try {
          return await work();
        } finally {
          captureFinished = true;
        }
      },
      FrozenWorker as unknown as typeof Worker,
    );
    const worker = FrozenWorker.instances[0]!;
    const result = pending.then(
      () => null,
      (error) => error as Error,
    );
    if (phase !== "prepare") worker!.emit("message", { kind: "prepared" });
    await Promise.resolve();
    if (phase === "verification") worker!.emit("message", { kind: "captured" });
    await Promise.resolve();
    try {
      t.mock.timers.tick(limitMs);
      assert.equal(worker!.terminates, 1, "deadline must terminate the live worker");
      if (phase === "capture")
        assert.equal(captureFinished, false, "capture must still hold the writer before worker exit");
    } finally {
      worker!.emit("exit", 1);
      stopped.resolve(1);
    }
    assert.match((await result)!.message, /backup worker exceeded 1800000ms/);
  });
}
