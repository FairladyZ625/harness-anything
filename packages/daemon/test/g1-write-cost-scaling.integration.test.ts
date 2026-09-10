// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { G1_METRICS, G1_OPERATIONS, measureWriteCostScaling } from "./fixtures/g1-write-cost-scaling.ts";

test("measureWriteCostScaling drives every G1 operation once through the production daemon request path", async () => {
  const measured = await measureWriteCostScaling(5);
  assert.equal(measured.eventCount, 5);
  assert.deepEqual(Object.keys(measured.counts).sort(), [...G1_OPERATIONS].sort());
  for (const operation of G1_OPERATIONS) {
    const counters = measured.counts[operation];
    assert.deepEqual(Object.keys(counters).sort(), [...G1_METRICS].sort(), operation);
    for (const metric of G1_METRICS)
      assert.ok(Number.isSafeInteger(counters[metric]) && counters[metric] >= 0, `${operation}.${metric}`);
  }
  // Writes and receipt-show execute in the writer worker; git subprocess count comes from the
  // production counter, so a write that touches the follower spawns at least one process.
  assert.ok(measured.counts["task-create"].gitProcesses > 0);
  // Host-side reads never touch the writer worker or Git.
  assert.equal(measured.counts["task-list"].gitProcesses, 0);
});

test("measureWriteCostScaling is deterministic in shape across two independent ledgers", async () => {
  const [first, second] = await Promise.all([measureWriteCostScaling(5), measureWriteCostScaling(5)]);
  // Same fixed-content fixture at the same scale must cost the same regardless of which temp
  // directory or process ids the run happened to get.
  assert.deepEqual(first.counts, second.counts);
});
