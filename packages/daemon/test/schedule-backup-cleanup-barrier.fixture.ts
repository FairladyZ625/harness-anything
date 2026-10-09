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
  Atomics.store(control, 0, 1);
  parentPort!.postMessage({ backupHeld: true });
  Atomics.wait(control, 0, 1);
}
const remove = fs.rmSync,
  read = fs.readFileSync,
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
fs.readFileSync = (...args: Parameters<typeof fs.readFileSync>): ReturnType<typeof fs.readFileSync> => {
  if (workerData.phase === "manifest" && String(args[0]).includes(`${path.sep}payload${path.sep}`)) hold();
  return read(...args);
};
fs.cpSync = (source, destination, options) => {
  if (workerData.phase === "capture" && String(destination).includes(`${path.sep}payload${path.sep}`)) hold();
  if (workerData.phase === "drill" && String(destination).includes(`${path.sep}restore-drills${path.sep}`)) hold();
  return copy(source, destination, options);
};
syncBuiltinESMExports();
await import(workerData.moduleUrl);
