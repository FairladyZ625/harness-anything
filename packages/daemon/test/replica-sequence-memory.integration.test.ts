// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

test("replica publication remains bounded for 40,000 and 400,000 inline entries", { timeout: 240_000 }, async (t) => {
  const samples: { peakHeap: number; peakRss: number }[] = [];
  for (const count of [400_000, 40_000]) {
    const root = mkdtempSync(path.join(tmpdir(), "ha-replica-memory-"));
    const worker = new Worker(new URL("./replica-sequence-memory.fixture.ts", import.meta.url), {
      workerData: { root, count },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let result: { peakHeap: number; peakRss: number } | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        worker.on("message", (message) => {
          t.diagnostic(JSON.stringify(message));
          if (message.phase === "complete") result = message;
        });
        worker.once("error", reject);
        worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`memory fixture exited ${code}`))));
      });
      assert.ok(result, "publication must complete below the fixed worker heap limit");
      assert.ok(result.peakHeap < 192 * 1024 ** 2, `peak heap ${result.peakHeap}`);
      assert.ok(result.peakRss < 768 * 1024 ** 2, `peak RSS ${result.peakRss}`);
      samples.push(result);
    } finally {
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.ok(samples[0]!.peakHeap <= samples[1]!.peakHeap + 64 * 1024 ** 2, "10x entries must not retain 10x heap");
});
