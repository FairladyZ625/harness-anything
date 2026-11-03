// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { G1_METRICS, G1_OPERATIONS, measureWriteCostScaling } from "./fixtures/g1-write-cost-scaling.ts";

test("task-create retains its existing SQL row budget at the gate's 200-event scale", async () => {
  const measured = await measureWriteCostScaling(200),
    rows = measured.counts["task-create"].sqlRowsRead,
    budget = JSON.parse(readFileSync(new URL("../../../tools/gates/cost-budget.json", import.meta.url), "utf8"))
      .writeCostScaling.budgets["task-create"].sqlRowsRead;
  console.log(`G1_TASK_CREATE_ROWS_200 actual=${rows} budget=${budget}`);
  assert.ok(rows <= budget, `task-create read ${rows} SQL rows; existing budget is ${budget}`);
});

test("measureWriteCostScaling drives every G1 operation through the production daemon request path", async () => {
  const measured = await measureWriteCostScaling(5);
  assert.equal(measured.eventCount, 5);
  for (const counts of [measured.counts, measured.firstCall]) {
    assert.deepEqual(Object.keys(counts).sort(), [...G1_OPERATIONS].sort());
    for (const operation of G1_OPERATIONS) {
      const counters = counts[operation];
      assert.deepEqual(Object.keys(counters).sort(), [...G1_METRICS].sort(), operation);
      for (const metric of G1_METRICS)
        assert.ok(Number.isSafeInteger(counters[metric]) && counters[metric] >= 0, `${operation}.${metric}`);
    }
  }
  // The write window closes after the Git/worktree follower publication the write triggered, so a
  // write counts the follower's Git subprocesses; receipt-show appends nothing and triggers none.
  assert.ok(measured.counts["task-create"].gitProcesses > 0);
  assert.equal(measured.counts["receipt-show"].gitProcesses, 0);
  // Host-side reads never touch the writer worker or Git.
  assert.equal(measured.counts["task-list"].gitProcesses, 0);
});

test("measureWriteCostScaling costs the same on two independent ledgers of the same scale", async () => {
  // Measured one after the other, as the gate does: host-side reads share process-wide counters.
  const first = await measureWriteCostScaling(5),
    second = await measureWriteCostScaling(5);
  // Same fixed-content fixture at the same scale must cost the same regardless of which temp
  // directory or process ids the run happened to get.
  assert.deepEqual(first.counts, second.counts);
  assert.deepEqual(first.firstCall, second.firstCall);
});

test("work-task scaling changes one parent's child count while retaining the same ledger size", async () => {
  const small = await measureWriteCostScaling(5, { workTaskCount: 1 }),
    large = await measureWriteCostScaling(5, { workTaskCount: 2 });
  assert.deepEqual([small.eventCount, large.eventCount], [5, 5]);
  assert.deepEqual(Object.keys(small.counts), ["task-create"]);
  assert.deepEqual(large.counts, small.counts);
});
