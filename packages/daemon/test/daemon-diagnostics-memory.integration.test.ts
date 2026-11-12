// harness-test-tier: integration
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import type { openDaemonMemoryLedger } from "../src/daemon-diagnostics-memory.ts";
import { openDaemonDiagnostics } from "../src/daemon-diagnostics.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { daemonDiagnosticsEndpoint, localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";

test(
  "diagnostic socket includes its own worker and nested worker isolates, then removes exits",
  { timeout: 30_000 },
  async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-memory-ledger-")),
      endpoint = localUserDaemonEndpoint(userRoot, "memory");
    const diagnostics = await openDaemonDiagnostics({ userRoot, endpoint, daemonId: "memory", metricsIntervalMs: 20 });
    const worker = new Worker(new URL("./fixtures/diagnostics-memory-tree.ts", import.meta.url), {
      name: "memory-parent",
      workerData: { nested: true },
    });
    try {
      await once(worker, "message");
      type Memory = ReturnType<ReturnType<typeof openDaemonMemoryLedger>["snapshot"]>;
      let memory: Memory | undefined,
        hasMetrics = false;
      const read = async () => {
        const snapshot = await requestDaemonJsonRpcAt(
          daemonDiagnosticsEndpoint(endpoint),
          "daemon.status",
          {},
          500,
          2_000,
        );
        hasMetrics = snapshot.metrics !== null && snapshot.metrics !== undefined;
        memory = (snapshot.metrics as { memory?: Memory } | undefined)?.memory;
        return memory;
      };
      await waitForDurableCondition(async () => {
        await read();
        return hasMetrics;
      });
      assert.ok(memory, "the live diagnostic snapshot must contain the all-thread memory ledger");
      await waitForDurableCondition(async () => {
        const value = await read();
        return value?.workers.sampled === 3 && value.workers.byRole["nested-memory"]?.sampled === 1;
      });
      assert.equal(memory!.workers.active, 3, "diagnostics + parent + nested isolate");
      assert.ok(memory!.workers.external >= 16 * 1024 * 1024);
      assert.equal(memory!.allThreads.heapTotal, memory!.mainThread.heapTotal + memory!.workers.heapTotal);
      console.log("DIAGNOSTICS_MEMORY", JSON.stringify(memory!));
      const reply = once(worker, "message");
      worker.postMessage("stop-child");
      await reply;
      console.log("MEMORY_STEP nested exit acknowledged");
      await waitForDurableCondition(async () => (await read())?.workers.active === 2);
      console.log("MEMORY_STEP two isolates observed");
      await worker.terminate();
      await waitForDurableCondition(async () => (await read())?.workers.active === 1);
      console.log("MEMORY_STEP one isolate observed");
    } finally {
      await worker.terminate();
      console.log("MEMORY_STEP closing diagnostics");
      await diagnostics.close();
      console.log("MEMORY_STEP diagnostics closed");
      rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
