import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { acquirePGliteDirectoryMutex } from "../../src/pglite/data-dir-mutex.ts";

const directory = isMainThread ? process.argv[2] : workerData.directory;
const lease = acquirePGliteDirectoryMutex(directory);
if (isMainThread) {
  process.send!({ held: true });
  process.on("message", () => {
    lease.close();
    process.disconnect();
  });
} else {
  parentPort!.postMessage({ held: true });
  parentPort!.on("message", () => {
    lease.close();
    parentPort!.close();
  });
}
