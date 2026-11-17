// Worker preload: report every writer-epoch database open to the parent thread.
import { DatabaseSync } from "node:sqlite";
import { MessagePort, parentPort } from "node:worker_threads";

// Observe the native isolate port. The supervised facade also forwards host
// capability messages, which are not calls made by the canonical Writer.
const post = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (message, ...args) {
  if (this === parentPort && message?.schema === "harness-repo-writer-capability-call/v1" && message.sync)
    post.call(this, { schema: "writer-physical-capability-probe/v1", capability: message.capability });
  return post.call(this, message, ...args);
};

const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (String(sql).includes("CREATE TABLE IF NOT EXISTS writer_epoch_history"))
    parentPort?.postMessage({ schema: "writer-epoch-open-probe/v1" });
  return exec.call(this, sql);
};
