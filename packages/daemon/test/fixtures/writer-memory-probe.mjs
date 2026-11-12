import { registerHooks } from "node:module";
import { parentPort } from "node:worker_threads";
const modules = new Set();
let sourceBytes = 0;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!modules.has(url) && loaded.source !== null && loaded.source !== undefined) {
      modules.add(url);
      sourceBytes += Buffer.byteLength(loaded.source);
    }
    return loaded;
  },
});
parentPort.on("message", (message) => {
  if (message !== "memory-probe") return;
  parentPort.postMessage({
    schema: "writer-memory-probe/v1",
    modules: modules.size,
    deliveryModules: [...modules].filter((url) => /\/packages\/(?:cli|gui)\//u.test(url)),
    sourceBytes,
    memory: process.memoryUsage(),
  });
});
