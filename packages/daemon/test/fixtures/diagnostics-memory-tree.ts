import { parentPort, Worker, workerData } from "node:worker_threads";
import { observeWorkerMemory } from "../../src/daemon-diagnostics-memory.ts";
observeWorkerMemory();
const retained = {
  heap: Array.from({ length: 200_000 }, (_, index) => ({ index })),
  bytes: Buffer.alloc(8 * 1024 * 1024, 1),
};
const child = workerData?.nested
  ? new Worker(new URL(import.meta.url), { name: "nested-memory", workerData: {} })
  : null;
if (child) await new Promise<void>((resolve) => child.once("message", () => resolve()));
parentPort!.on("message", async () => {
  await child?.terminate();
  parentPort!.postMessage(retained.heap.length + retained.bytes.length);
});
parentPort!.postMessage("ready");
