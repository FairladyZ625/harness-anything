// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { lifecycleHarness } from "./task-lifecycle-test-harness.ts";

test("G29 submit publishes only its frozen targets while preserving unrelated bytes", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    mkdirSync(path.join(harness.rootDir, "harness"), { recursive: true });
    const sentinel = path.join(harness.rootDir, "harness/unrelated.bin");
    writeFileSync(sentinel, Buffer.from([0, 1, 2, 255]));
    const before = readFileSync(sentinel);

    harness.kill("after_event_write");
    await assert.rejects(harness.submit("execution-1"), /killpoint:after_event_write/u);
    assert.equal(harness.eventStore.recover().status, "committed");

    const read = await harness.service.read("task-1");
    assert.equal(read.snapshot.executions[0]?.state, "submitted");
    assert.equal(read.snapshot.task?.status, "in_review");
    assert.equal(read.snapshot.task?.currentNode, "review");
    assert.deepEqual(read.snapshot.edgesTaken.map((edge) => edge.on), ["submitted"]);
    assert.equal(read.snapshot.lease, null);
    assert.deepEqual(readFileSync(sentinel), before);
  } finally {
    harness.cleanup();
  }
});
