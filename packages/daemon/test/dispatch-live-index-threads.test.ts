// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { openDispatchStream } from "../src/dispatch-stream.ts";

// The repository writer runs in a worker thread and the read path runs on the main thread; both
// rewrite a task's live index, and threads of one process share process.pid.
const openStreams = (rootDir: string, prefix: string, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    const suffix = `${prefix}${index.toString(16).padStart(24 - prefix.length, "0")}`;
    openDispatchStream(rootDir, {
      dispatchId: `dispatch_${suffix}`,
      taskId: "task-1",
      executionId: "execution-1",
      runtimeSessionId: `runtime_${suffix}`,
      instanceId: "instance-1",
      startedAt: "2026-09-29T00:00:00.000Z",
    });
  }
};

test("two threads writing one task's live index do not collide on the temporary file", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-live-index-threads-"));
  try {
    // Both loops start together: the worker loads the module first, then waits on this gate.
    const gate = new SharedArrayBuffer(4);
    const worker = new Worker(
      `const { workerData, parentPort } = require("node:worker_threads");
       import(workerData.module).then(({ openDispatchStream }) => {
         const gate = new Int32Array(workerData.gate);
         parentPort.postMessage("ready");
         Atomics.wait(gate, 0, 0);
         try {
           for (let index = 0; index < workerData.count; index += 1) {
             const suffix = "b" + index.toString(16).padStart(23, "0");
             openDispatchStream(workerData.rootDir, { dispatchId: "dispatch_" + suffix, taskId: "task-1",
               executionId: "execution-1", runtimeSessionId: "runtime_" + suffix, instanceId: "instance-1",
               startedAt: "2026-09-29T00:00:00.000Z" });
           }
           parentPort.postMessage(null);
         } catch (error) { parentPort.postMessage(String(error)); }
       });`,
      {
        eval: true,
        workerData: { module: new URL("../src/dispatch-stream.ts", import.meta.url).href, rootDir, count: 2000, gate },
      },
    );
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const workerError = new Promise<string | null>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    let mainError: string | null = null;
    try {
      openStreams(rootDir, "a", 2000);
    } catch (error) {
      mainError = String(error);
    }
    assert.deepEqual({ main: mainError, worker: await workerError }, { main: null, worker: null });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
