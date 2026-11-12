import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { workerData } from "node:worker_threads";

const barrier = new Int32Array(workerData.barrier as SharedArrayBuffer),
  stat = fs.statSync;
// edgeFreshness stats the pointer after acquiring the generation and opening its reader.
// Hold that real read while the receiver publishes and collects a replacement generation.
fs.statSync = ((file, ...args) => {
  if (String(file).endsWith("/current.json") && Atomics.compareExchange(barrier, 0, 1, 2) === 1) {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    Atomics.wait(barrier, 2, 0);
  }
  return Reflect.apply(stat, fs, [file, ...args]);
}) as typeof fs.statSync;
syncBuiltinESMExports();
await import("../../src/repo-reader-worker.ts");
