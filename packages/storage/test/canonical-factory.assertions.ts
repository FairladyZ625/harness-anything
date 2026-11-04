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
  projection.rebuild();
  assert.deepEqual(projection.read(taskId).snapshot, snapshot);
  return { events, snapshot };
}
