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

test("a claim the lifecycle contract rejects leaves the previous lease untouched instead of an orphan reservation", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1", "op-start-1", "2026-08-11T00:02:00.000Z");
    // The lease has lapsed by the time the second claim occurs (00:03), so the reservation CAS admits it,
    // but the round still owns an active execution, so the transition rejects the command.
    await assert.rejects(harness.start("execution-2", "op-start-2"), /StartExecution requires a new execution/u);
    const lease = harness.projection.currentLease("task-1", "2026-08-11T00:04:00.000Z");
    assert.equal(lease?.executionId, "execution-1");
    assert.equal(lease?.phase, "orphaned");
    assert.equal(lease?.version, 1);
  } finally {
    harness.cleanup();
  }
});
