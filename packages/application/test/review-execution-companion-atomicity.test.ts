// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleHarness } from "./task-lifecycle-test-harness.ts";

test("changes_requested records Review, return edge, Execution closure, and Task reactivation together", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    harness.kill("after_event_write");
    await assert.rejects(harness.review("execution-1", "anti_entropy", "changes_requested"), /killpoint:after_event_write/u);
    assert.equal(harness.eventStore.recover().status, "committed");
    const snapshot = (await harness.service.read("task-1")).snapshot;
    assert.equal(snapshot.reviews.at(-1)?.verdict, "changes_requested");
    assert.equal(snapshot.edgesTaken.at(-1)?.on, "changes_requested");
    assert.equal(snapshot.executions[0]?.state, "changes_requested");
    assert.notEqual(snapshot.executions[0]?.closedAt, null);
    assert.equal(snapshot.task?.status, "active");
    assert.equal(snapshot.task?.currentNode, "implementation");
    assert.equal(snapshot.task?.iteration, 1);
    assert.equal(snapshot.lease, null);
  } finally {
    harness.cleanup();
  }
});
