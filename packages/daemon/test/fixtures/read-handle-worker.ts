import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";

// Count real native connections touched by the production query runtime. The counters
// are shared, so close() must publish its receipt after every observed handle is closed.
const counts = new Int32Array(workerData.handles as SharedArrayBuffer),
  active = new Set<DatabaseSync>(),
  prepare = DatabaseSync.prototype.prepare,
  close = DatabaseSync.prototype.close;
DatabaseSync.prototype.prepare = function (sql) {
  if (!active.has(this)) {
    active.add(this);
    Atomics.add(counts, 0, 1);
  }
  return prepare.call(this, sql);
};
DatabaseSync.prototype.close = function () {
  const result = close.call(this);
  if (active.delete(this)) Atomics.add(counts, 1, 1);
  return result;
};
await import("../../src/repo-reader-worker.ts");
