// harness-test-tier: integration
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

interface MemorySample {
  phase: string;
  peakHeap: number;
  peakRss: number;
  peakRetainedHeap: number;
}

test("replica publication remains bounded for 40,000 and 400,000 inline entries", { timeout: 240_000 }, async (t) => {
  const samples: MemorySample[] = [];
  for (const count of [400_000, 40_000]) {
    const root = mkdtempSync(path.join(tmpdir(), "ha-replica-memory-"));
    // A process can expose GC and gives RSS the same scope as the measured heap.
    const child = fork(new URL("./replica-sequence-memory.fixture.ts", import.meta.url), [root, String(count)], {
      execArgv: ["--expose-gc", "--max-old-space-size=256"],
      signal: t.signal,
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let result: MemorySample | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child.on("message", (message: MemorySample) => {
          t.diagnostic(JSON.stringify(message));
          if (message.phase === "complete") result = message;
        });
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`memory fixture exited ${code}`))));
      });
      assert.ok(result, "publication must complete below the fixed process heap limit");
      assert.ok(result.peakHeap < 192 * 1024 ** 2, `peak heap ${result.peakHeap}`);
      assert.ok(result.peakRss < 768 * 1024 ** 2, `peak RSS ${result.peakRss}`);
      samples.push(result);
    } finally {
      child.kill();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.ok(
    samples[0]!.peakRetainedHeap <= samples[1]!.peakRetainedHeap + 64 * 1024 ** 2,
    "10x entries must not retain 10x heap",
  );
});
