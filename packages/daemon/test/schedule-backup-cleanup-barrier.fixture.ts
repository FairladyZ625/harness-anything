import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

// Hold actual payload hashing, restore copying or retention deletion in the worker.
const control = workerData.control as Int32Array;
let held = false;
function hold(): void {
  if (held) return;
  held = true;
  // A teardown release can arrive before the worker reaches this phase.
  Atomics.compareExchange(control, 0, 0, 1);
  parentPort!.postMessage({ backupHeld: true });
  Atomics.wait(control, 0, 1);
}
const remove = fs.rmSync,
  open = fs.openSync,
  copy = fs.cpSync;
fs.rmSync = (candidate, options) => {
  if (
    workerData.phase === "cleanup" &&
    (String(candidate) === workerData.holdAt ||
      path.resolve(String(candidate)) === path.resolve(workerData.holdAt) ||
      String(candidate).replace(/^\/private/, "") === String(workerData.holdAt).replace(/^\/private/, ""))
  )
    hold();
  return remove(candidate, options);
};
fs.openSync = (candidate, flags, mode) => {
  const descriptor = open(candidate, flags, mode);
  if (workerData.phase === "manifest" && String(candidate).includes(`${path.sep}payload${path.sep}`)) hold();
  return descriptor;
};
fs.cpSync = (source, destination, options) => {
  if (workerData.phase === "capture" && String(destination).includes(`${path.sep}payload${path.sep}`)) hold();
  if (workerData.phase === "drill" && String(destination).includes(`${path.sep}restore-drills${path.sep}`)) hold();
  return copy(source, destination, options);
};
syncBuiltinESMExports();
await import(workerData.moduleUrl);
