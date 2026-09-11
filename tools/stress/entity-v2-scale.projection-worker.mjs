import { parentPort, workerData } from "node:worker_threads";
import { makeTaskEventReader, makeTaskProjection } from "../../packages/kernel/src/index.ts";

// Follows a ledger that another thread is appending to, the way a running daemon keeps its projection
// current. The parent posts { revision, digest } once that revision is final; the follower stops there.
const { rootDir, repoId, projectionPath } = workerData;
const reader = makeTaskEventReader({ rootDir, repoId }),
  started = performance.now();
let reported = { watermark: 0, at: started };
const projection = makeTaskProjection({
  rootDir,
  eventStore: reader,
  ...(projectionPath ? { projectionPath } : {}),
  // Reports every few catch-up rounds, so a run cut short still shows how far replay got.
  onProgress: ({ watermark: reached }) => {
    if (reached - reported.watermark < 16_384 && performance.now() - reported.at < 10_000) return;
    reported = { watermark: reached, at: performance.now() };
    parentPort.postMessage({ progress: true, watermark: reached, elapsedMs: reported.at - started });
  },
});
let target = null,
  busyMs = 0,
  rounds = 0,
  watermark = 0;
parentPort.on("message", (message) => {
  target = message;
});
let report;
try {
  for (;;) {
    const roundStarted = performance.now();
    watermark = projection.catchUp().watermark;
    busyMs += performance.now() - roundStarted;
    rounds += 1;
    if (target !== null && watermark >= target.revision) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const digestStarted = performance.now(),
    stateDigest = target.digest ? projection.readStateDigest() : null;
  report = {
    ok: true,
    watermark,
    busyMs,
    elapsedMs: performance.now() - started,
    rounds,
    stateDigest,
    digestMs: performance.now() - digestStarted,
  };
} catch (error) {
  report = { ok: false, error: error instanceof Error ? error.message : String(error), watermark };
} finally {
  projection.close();
  await reader.drain();
}
// Report only once the projection is closed, so the parent may hand the file to the daemon.
parentPort.postMessage({ progress: false, ...report });
parentPort.close();
