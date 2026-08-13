// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleHarness } from "./task-lifecycle-test-harness.ts";

test("claim releases its CAS reservation before publication and converges from a committed event after response loss", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    harness.kill("after_event_write");
    await assert.rejects(harness.start("execution-failed", "op-start-failed"), /killpoint:after_event_write/u);
    assert.equal(harness.projection.currentLease("task-1")?.phase, "released");
    assert.equal(harness.eventStore.read().events.length, 1);
    assert.equal(harness.eventStore.recover().status, "none");

    harness.kill("after_git_commit");
    await assert.rejects(harness.start("execution-1", "op-start-1"), /killpoint:after_git_commit/u);
    assert.equal(harness.eventStore.recover().status, "already_committed");
    const converged = await harness.service.read("task-1");
    assert.equal(converged.status, "ready");
    assert.equal(converged.snapshot.executions[0]?.state, "active");
    assert.equal(converged.snapshot.lease?.phase, "active");
  } finally {
    harness.cleanup();
  }
});
