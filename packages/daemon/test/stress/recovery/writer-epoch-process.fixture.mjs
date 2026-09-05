import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [source, stateRoot, arm, holderId = arm] = process.argv.slice(2);
if (!source || !stateRoot || !["acquire", "kill-after-history"].includes(arm))
  throw new Error("usage: writer-epoch-process.fixture.mjs <source> <state-root> <arm> [holder-id]");

if (arm === "kill-after-history") {
  const originalRun = StatementSync.prototype.run;
  StatementSync.prototype.run = function (...args) {
    const result = originalRun.apply(this, args);
    if (this.sourceSQL.startsWith("INSERT INTO writer_epoch_history")) {
      fs.writeSync(1, "history-inserted-before-state-publish\n");
      process.kill(process.pid, "SIGKILL");
    }
    return result;
  };
  syncBuiltinESMExports();
}

const { openPersistentWriterEpoch } = await import(pathToFileURL(source).href),
  authority = openPersistentWriterEpoch({ stateRoot, holderId }),
  lease = authority.acquire("stress-s3-repo");
fs.writeSync(1, `${JSON.stringify(lease)}\n`);
authority.close();
