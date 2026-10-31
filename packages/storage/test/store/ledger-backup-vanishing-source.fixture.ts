import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const input = workerData as { readonly sourceDir: string; readonly triggerPath: string; readonly prefix: string };
// 1 ms sleeps: coarse enough to land after the copy's directory enumeration, fine enough
// to overtake entries it has not visited yet.
const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
parentPort!.postMessage({ ready: true });
while (!existsSync(input.triggerPath)) Atomics.wait(sleeper, 0, 0, 1);
const vanished = readdirSync(input.sourceDir).filter((name) => name.startsWith(input.prefix));
for (const name of vanished) rmSync(path.join(input.sourceDir, name), { force: true });
parentPort!.postMessage({ vanished: vanished.length });
