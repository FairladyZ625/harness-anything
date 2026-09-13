// Worker preload: report every SharedArrayBuffer allocation to the parent thread.
import { parentPort } from "node:worker_threads";

const shared = globalThis.SharedArrayBuffer;
globalThis.SharedArrayBuffer = class extends shared {
  constructor(byteLength) {
    super(byteLength);
    parentPort?.postMessage({ schema: "writer-sab-allocation-probe/v1", byteLength });
  }
};
