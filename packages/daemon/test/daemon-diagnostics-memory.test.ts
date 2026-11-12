// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { openDaemonMemoryLedger, labelWorkerMemory } from "../src/daemon-diagnostics-memory.ts";

test("memory ledger sums isolate heaps and external without adding its arrayBuffers subset", async () => {
  const ledger = openDaemonMemoryLedger(),
    child = new EventEmitter() as EventEmitter & {
      threadId: number;
      threadName: string;
      getHeapStatistics: () => Promise<unknown>;
    };
  Object.assign(child, {
    threadId: 42,
    threadName: "native-name",
    getHeapStatistics: async () => ({ total_heap_size: 50, used_heap_size: 30, external_memory: 11 }),
  });
  const main = { rss: 500, heapTotal: 100, heapUsed: 60, external: 20, arrayBuffers: 15 };
  try {
    labelWorkerMemory(child as unknown as Worker, "repo-writer");
    process.emit("worker", child as unknown as Worker);
    await Promise.resolve();
    const snapshot = ledger.snapshot(main);
    assert.equal(snapshot.rss, 500, "RSS belongs to the process and is never summed across workers");
    assert.deepEqual(snapshot.allThreads, { heapTotal: 150, heapUsed: 90, external: 31 });
    assert.equal(snapshot.workers.active, 1);
    assert.equal(snapshot.workers.sampled, 1);
    assert.equal(snapshot.workers.byRole["repo-writer"]!.heapTotal, 50);
    assert.equal(snapshot.mainThread.arrayBuffers, 15, "arrayBuffers remains informational");
    child.emit("exit", 0);
    assert.equal(ledger.snapshot(main).workers.active, 0, "retired isolates leave the live inventory");
  } finally {
    ledger.close();
  }
});

test("an unresponsive isolate is counted without fabricating a zero heap sample", () => {
  const ledger = openDaemonMemoryLedger(),
    child = new EventEmitter();
  Object.assign(child, { threadId: 43, threadName: "blocked", getHeapStatistics: () => new Promise(() => {}) });
  try {
    process.emit("worker", child as unknown as Worker);
    const snapshot = ledger.snapshot({ rss: 1, heapTotal: 1, heapUsed: 1, external: 0, arrayBuffers: 0 });
    assert.equal(snapshot.workers.active, 1);
    assert.equal(snapshot.workers.sampled, 0);
    assert.equal(snapshot.workers.isolates[0]!.sampledAt, null);
    assert.equal(snapshot.workers.isolates[0]!.heap, null);
  } finally {
    child.emit("exit", 0);
    ledger.close();
  }
});
