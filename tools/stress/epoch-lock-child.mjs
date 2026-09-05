// Test process only: expose the boundary between exclusive lock creation and PID publication.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { openPersistentWriterEpoch } from "../../packages/daemon/src/writer-epoch.ts";

const [stateRoot, arm] = process.argv.slice(2);
if (!["kill-after-create", "acquire"].includes(arm)) throw new Error("unknown probe arm");
if (arm === "kill-after-create") {
  const originalOpen = fs.openSync;
  fs.openSync = function (file, flags, ...rest) {
    const fd = originalOpen.call(fs, file, flags, ...rest);
    if (String(file).endsWith("writer-epochs.lock") && flags === "wx") {
      fs.writeSync(1, "lock-created-before-pid\n");
      process.kill(process.pid, "SIGKILL");
    }
    return fd;
  };
  syncBuiltinESMExports();
}
fs.writeSync(1, "acquire-entered\n");
const writer = openPersistentWriterEpoch({ stateRoot, holderId: "probe" });
const lease = writer.acquire("probe-repo");
fs.writeSync(1, `${JSON.stringify({ acquired: lease.epoch })}\n`);
writer.close();
