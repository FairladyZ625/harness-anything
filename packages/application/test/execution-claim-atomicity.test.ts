// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { openSqliteEventStore } from "../../kernel/src/index.ts";
import { lifecycleHarness } from "./task-lifecycle-test-harness.ts";

test("claim releases its CAS reservation after response loss and converges from the accepted SQLite cut", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    harness.kill("after_sqlite_commit");
    await assert.rejects(harness.start("execution-failed", "op-start-failed"), /killpoint:after_sqlite_commit/u);
    assert.equal(harness.projection.currentLease("task-1")?.phase, "released");
    assert.equal(harness.eventStore.read().events.length, 2);
    const reopened = openSqliteEventStore({ repoId: "test-repo", rootInput: harness.rootDir, readOnly: true });
    try {
      assert.equal(
        reopened.readCommandOutcome(harness.eventStore.read().events.at(-1)!.opId)?.status,
        "accepted_durable",
      );
    } finally {
      reopened.close();
    }
    harness.projection.catchUp();
    const converged = await harness.service.read("task-1");
    assert.equal(converged.status, "ready");
    assert.equal(converged.snapshot.executions[0]?.state, "active");
    assert.equal(converged.snapshot.lease?.phase, "held");
  } finally {
    await harness.cleanup();
  }
});

test("a claim the lifecycle contract rejects leaves the previous lease untouched instead of an orphan reservation", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1", "op-start-1", "2026-08-11T00:02:00.000Z");
    harness.projection.catchUp();
    // The lease has lapsed by the time the second claim occurs (00:03), so the reservation CAS admits it,
    // but the round still owns an active execution, so the transition rejects the command.
    await assert.rejects(harness.start("execution-2", "op-start-2"), /StartExecution requires a new execution/u);
    const lease = harness.projection.currentLease("task-1", "2026-08-11T00:04:00.000Z");
    assert.equal(lease?.executionId, "execution-1");
    assert.equal(lease?.phase, "orphaned");
    assert.equal(lease?.version, 1);
  } finally {
    await harness.cleanup();
  }
});

test("claim interrupted before the SQLite outcome rolls back the event and releases its CAS reservation", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    harness.kill("after_event_write");
    await assert.rejects(harness.start("execution-failed", "op-start-failed"), /killpoint:after_event_write/u);
    assert.equal(harness.eventStore.read().events.length, 1);
    const reopened = openSqliteEventStore({ repoId: "test-repo", rootInput: harness.rootDir, readOnly: true });
    try {
      assert.equal(reopened.outcomes().length, 1);
    } finally {
      reopened.close();
    }
    assert.equal(harness.projection.currentLease("task-1")?.phase, "released");
    harness.projection.catchUp();
    assert.deepEqual((await harness.service.read("task-1")).snapshot.executions, []);
    assert.equal((await harness.start("execution-failed", "op-start-failed")).outcome, "applied");
  } finally {
    await harness.cleanup();
  }
});
