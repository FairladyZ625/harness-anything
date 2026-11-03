import { parentPort, workerData } from "node:worker_threads";
import { gateRequest } from "./read-p99-gate.ts";
const barrier = new Int32Array(workerData.barrier as SharedArrayBuffer);
parentPort!.on("message", (request) => gateRequest(barrier, request));
await import("../../src/repo-writer-worker.ts");
