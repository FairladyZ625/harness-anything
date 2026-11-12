import { parentPort, workerData } from "node:worker_threads";
import type { RepoReadPayload, RepoWriterRequestV1 } from "../../src/repo-writer-protocol.ts";
const barrier = new Int32Array(workerData.barrier as SharedArrayBuffer);
// Inject synchronous CPU/I/O occupancy before the real query, on the actual production worker.
parentPort!.on("message", (request: RepoWriterRequestV1) => {
  const payload = request.payload as RepoReadPayload;
  if (Atomics.load(barrier, 0) !== 1 || payload.method !== "read") return;
  Atomics.add(barrier, 1, 1);
  Atomics.notify(barrier, 1);
  Atomics.wait(barrier, 2, 0);
});
await import("../../src/repo-reader-worker.ts");
