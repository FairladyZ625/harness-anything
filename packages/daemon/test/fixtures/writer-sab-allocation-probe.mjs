// Worker preload: report every SharedArrayBuffer allocation to the parent thread.
import { parentPort } from "node:worker_threads";

const shared = globalThis.SharedArrayBuffer;
// Structured cloning restores the native prototype. Preserve it while observing construction.
globalThis.SharedArrayBuffer = new Proxy(shared, {
  construct(target, args, newTarget) {
    const buffer = Reflect.construct(target, args, newTarget);
    parentPort?.postMessage({ schema: "writer-sab-allocation-probe/v1", byteLength: buffer.byteLength });
    return buffer;
  },
});
