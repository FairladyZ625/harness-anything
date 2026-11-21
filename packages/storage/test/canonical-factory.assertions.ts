import assert from "node:assert/strict";
import {
  taskLifecycleWritePlan,
  type CanonicalEventStore,
  type TaskProjectionPort,
  type TaskProjectionReaderPort,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";

/** The synchronous factory contract is identical for every physical backend. */
export function assertCanonicalFactoryLifecycle(input: {
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjectionPort;
  readonly reader: () => TaskProjectionReaderPort;
  readonly taskId: string;
  readonly executionId: string;
}) {
  const { store, projection, taskId, executionId } = input,
    events = lifecycleFixture({ taskId, executionId }).events;
  for (const event of events) {
    store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    projection.apply(event, taskLifecycleWritePlan(event));
  }
  const snapshot = projection.read(taskId).snapshot;
  assert.equal(snapshot.task?.status, "done");
  assert.equal(store.readHead()?.revision, events.length);
  const reader = input.reader();
  try {
    assert.deepEqual(
      reader.withSession((queries) => queries.read(taskId).snapshot),
      snapshot,
    );
  } finally {
    reader.close();
  }
  let cursor: string | null = null;
  const replay = [];
  do {
    const batch = store.readBatch(cursor, 2);
    replay.push(...batch.events);
    cursor = batch.cursor;
    if (batch.done) break;
  } while (replay.length <= events.length);
  assert.deepEqual(replay, events);
  if (store.readEventWindow !== undefined) {
    const revWindow = store.readEventWindow({ afterRevision: 1, maxRevision: 4, limit: 2 });
    assert.equal(revWindow.sourceRevision, events.length);
    assert.deepEqual(
      revWindow.events.map((event) => event.workspaceRevision),
      [2, 3],
    );
    assert.equal(revWindow.done, false);
    const revWindowNext = store.readEventWindow({
      afterRevision: revWindow.lastScannedRevision,
      maxRevision: 4,
      limit: 2,
    });
    assert.deepEqual(
      revWindowNext.events.map((event) => event.workspaceRevision),
      [4],
    );
    assert.equal(revWindowNext.done, true);
    const timeWindow = store.readEventWindow({
      afterRevision: 0,
      after: events[0]!.occurredAt,
      before: events.at(-1)!.occurredAt,
      limit: events.length + 1,
    });
    assert.equal(timeWindow.done, true);
    assert.deepEqual(timeWindow.events, events);
    const emptyWindow = store.readEventWindow({
      afterRevision: 0,
      after: "2099-01-01T00:00:00.000Z",
      before: "2099-01-01T23:59:59.999Z",
      limit: 10,
    });
    assert.equal(emptyWindow.done, true);
    assert.equal(emptyWindow.events.length, 0);
  }
  projection.rebuild();
  assert.deepEqual(projection.read(taskId).snapshot, snapshot);
  return { events, snapshot };
}
