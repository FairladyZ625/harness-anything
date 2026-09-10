// Worker preload: report every writer-epoch database open to the parent thread.
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (String(sql).includes("CREATE TABLE IF NOT EXISTS writer_epoch_history"))
    parentPort?.postMessage({ schema: "writer-epoch-open-probe/v1" });
  return exec.call(this, sql);
};
