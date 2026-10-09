import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

// The executor has captured its canonical read snapshot before the first build transaction.
const control = workerData.control as Int32Array;
const exec = DatabaseSync.prototype.exec;
let held = false;
DatabaseSync.prototype.exec = function (sql: string): void {
  if (!held && sql === "BEGIN IMMEDIATE") {
    held = true;
    Atomics.store(control, 0, 1);
    parentPort!.postMessage({ checkpointBuildHeld: true });
    Atomics.wait(control, 0, 1);
  }
  return exec.call(this, sql);
};
await import(workerData.moduleUrl);
