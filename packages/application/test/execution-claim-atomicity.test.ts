// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleHarness } from "./task-lifecycle-test-harness.ts";

test("claim releases a pre-publication reservation and converges after an authored event killpoint", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    harness.kill("after_reservation");
    await assert.rejects(harness.start("execution-failed", "op-start-failed"), /killpoint:after_reservation/u);
    assert.equal(harness.leases.current("task-1"), null);
    assert.equal(harness.eventStore.read().events.length, 1);

    harness.kill("after_event_append");
    const interrupted = await harness.start("execution-1", "op-start-1");
    assert.equal(interrupted.outcome, "indeterminate");
    const converged = await harness.service.read("task-1");
    assert.equal(converged.status, "ready");
    assert.equal(converged.snapshot.executions[0]?.state, "active");
    assert.equal(converged.snapshot.lease?.phase, "active");
  } finally {
    harness.cleanup();
  }
});
