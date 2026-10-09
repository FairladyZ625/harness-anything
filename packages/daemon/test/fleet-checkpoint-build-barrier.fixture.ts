import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

// The executor has captured its canonical read snapshot before the first build transaction.
const control = workerData.control as Int32Array;
const exec = DatabaseSync.prototype.exec;
let transactions = 0;
let existingPreparation = false;
const hold = () => {
  Atomics.store(control, 0, 1);
  parentPort!.postMessage({ checkpointBuildHeld: true });
  Atomics.wait(control, 0, 1);
};
if (workerData.pauseBeforeRequest) {
  let requests = 0;
  parentPort!.on("message", () => {
    if (++requests === workerData.pauseBeforeRequest) {
      existingPreparation = true;
      hold();
    }
  });
}
DatabaseSync.prototype.exec = function (sql: string): void {
  if (sql === "BEGIN IMMEDIATE") {
    if (existingPreparation) throw new Error("checkpoint executor must not write after initial publication");
    if (!workerData.pauseBeforeRequest && ++transactions === (workerData.pauseAfter ?? 1)) hold();
  }
  return exec.call(this, sql);
};
await import(workerData.moduleUrl);
