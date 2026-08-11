// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleHarness } from "./task-lifecycle-test-harness.ts";

test("concurrent submits from one snapshot accept one payload and reject the other revision", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    const results = await Promise.allSettled([
      harness.submit("execution-1", "op-submit-a", "payload a"),
      harness.submit("execution-1", "op-submit-b", "payload b")
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const events = harness.eventStore.read().events;
    assert.equal(events.length, 3);
    assert.equal(events[2]?.type, "execution_submitted");
    assert.equal((await harness.service.read("task-1")).snapshot.executions[0]?.state, "submitted");
  } finally {
    harness.cleanup();
  }
});
