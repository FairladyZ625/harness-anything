// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { openReplicaCutWorker } from "../src/fleet/replica-cut-worker.ts";

test("a terminal worker exit preserves the original failure for later edge requests", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-worker-failure-"));
  const cause = Object.assign(new Error("Worker terminated due to reaching memory limit: JS heap out of memory"), {
    code: "ERR_WORKER_OUT_OF_MEMORY",
  });
  let exited: Promise<number> | undefined;
  t.mock.method(Worker.prototype, "postMessage", function (this: Worker) {
    // Exercise the real worker owner's error/exit callbacks in Node's terminal-event order.
    this.emit("error", cause);
    exited = this.terminate();
  });
  const source = openReplicaCutWorker(
    {
      repoId: "failure",
      localRoot: root,
      readSequence: (_from, read) => read(null),
      readRevision: () => null,
      readContentBlob: () => null,
    },
    { repoId: "failure", rootDir: root, localRoot: root },
  );
  try {
    const first = source.prepare(),
      second = source.prepare(),
      third = source.prepare();
    assert.strictEqual(first, second);
    assert.strictEqual(second, third);
    await assert.rejects(first, (error) => error === cause);
    await exited;
    await assert.rejects(source.prepare(), (error) => error === cause);
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});
