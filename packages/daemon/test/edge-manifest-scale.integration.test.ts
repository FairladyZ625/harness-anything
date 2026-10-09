// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

test(
  "400,000-entry edges ACK first and replacement snapshots, then apply and read a sparse delta",
  { timeout: 240_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-edge-manifest-scale-"));
    const worker = new Worker(new URL("./edge-manifest-scale.fixture.ts", import.meta.url), { workerData: { root } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        worker.on("message", (message) => {
          t.diagnostic(JSON.stringify(message));
          clearTimeout(timer);
          if (message.event === "start")
            timer = setTimeout(() => reject(new Error(`${message.phase} did not complete within 60 seconds`)), 60_000);
          if (message.phase === "complete") completed = true;
        });
        worker.once("error", reject);
        worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`edge fixture exited ${code}`))));
      });
      assert.ok(completed, "the actual receiver must finish every phase and return ACKs");
    } finally {
      clearTimeout(timer);
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
