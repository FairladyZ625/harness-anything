import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

// Hold the real retention deletion in its own worker. Only the filesystem operation
// is intercepted; the product drill, retention plan and settlement still execute.
const control = workerData.control as Int32Array,
  remove = fs.rmSync;
fs.rmSync = (candidate, options) => {
  if (String(candidate) === workerData.holdAt) {
    Atomics.store(control, 0, 1);
    parentPort!.postMessage({ cleanupHeld: true });
    Atomics.wait(control, 0, 1);
  }
  return remove(candidate, options);
};
syncBuiltinESMExports();
await import(workerData.moduleUrl);
