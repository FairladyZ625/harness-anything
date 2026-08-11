// harness-test-tier: integration
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/write-journal-coordinator.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("event projection rebuild is deterministic and discards tampered SQLite state", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const eventStore = makeTaskEventStore({ rootDir, coordinator: makeJournaledWriteCoordinator({ rootDir }) });
    for (const event of lifecycleFixture().events) assert.equal(Effect.runSync(eventStore.append(event)).status, "applied");
    const projection = makeTaskProjection({ rootDir, eventStore });

    const first = projection.read("task-1");
    assert.equal(first.status, "ready");
    assert.equal(first.snapshot.task?.status, "done");
    assert.deepEqual(first.snapshot.executions.map((execution) => execution.state), ["accepted"]);
    assert.deepEqual(first.snapshot.reviews.map((review) => review.kind), ["anti_entropy", "acceptance"]);
    assert.deepEqual(first.snapshot.edgesTaken.map((edge) => edge.on), ["submitted", "approved"]);

    rmSync(path.join(rootDir, ".harness/cache/task.sqlite"), { force: true });
    assert.deepEqual(projection.read("task-1").snapshot, first.snapshot);

    const db = new DatabaseSync(path.join(rootDir, ".harness/cache/task.sqlite"));
    db.prepare("UPDATE execution SET value_json = json_set(value_json, '$.state', 'submitted')").run();
    db.close();

    const repaired = projection.read("task-1");
    assert.equal(repaired.snapshot.executions[0]?.state, "accepted");
    assert.equal(repaired.warnings.includes("projection_tampered"), true);
  });
});

test("projection catch-up is bounded and never reports a stale row as ready", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const eventStore = makeTaskEventStore({ rootDir, coordinator: makeJournaledWriteCoordinator({ rootDir }) });
    for (const event of lifecycleFixture().events) Effect.runSync(eventStore.append(event));
    const projection = makeTaskProjection({ rootDir, eventStore, catchUpLimit: 2 });

    assertPending(projection.read("task-1"), 2, 6);
    assertPending(projection.read("task-1"), 4, 6);
    assert.equal(projection.read("task-1").status, "ready");
  });
});

function assertPending(read: ReturnType<ReturnType<typeof makeTaskProjection>["read"]>, watermark: number, sourceRevision: number) {
  assert.equal(read.status, "pending");
  assert.equal(read.watermark, watermark);
  assert.equal(read.sourceRevision, sourceRevision);
}
