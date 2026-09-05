import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [source, stateRoot, arm] = process.argv.slice(2);
if (!source || !stateRoot || !["kill-before-publish", "acquire"].includes(arm))
  throw new Error("invalid fixture input");

if (arm === "kill-before-publish") {
  const originalOpen = fs.openSync,
    originalExec = DatabaseSync.prototype.exec,
    die = () => {
      fs.writeSync(1, "exclusive-acquired-before-publish\n");
      process.kill(process.pid, "SIGKILL");
    };
  fs.openSync = function (file, flags, ...rest) {
    const fd = originalOpen.call(fs, file, flags, ...rest);
    if (String(file).endsWith("writer-epochs.lock") && flags === "wx") die();
    return fd;
  };
  DatabaseSync.prototype.exec = function (sql) {
    const result = originalExec.call(this, sql);
    if (sql.trim().toUpperCase() === "BEGIN IMMEDIATE") die();
    return result;
  };
  syncBuiltinESMExports();
}

const { openPersistentWriterEpoch } = await import(pathToFileURL(source).href),
  authority = openPersistentWriterEpoch({ stateRoot, holderId: arm === "acquire" ? "recovery" : "killed" }),
  lease = authority.acquire("repo");
fs.writeSync(1, `${JSON.stringify({ epoch: lease.epoch, holderId: lease.holderId })}\n`);
authority.close();
