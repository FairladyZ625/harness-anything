import assert from "node:assert/strict";
import {
  serializePersistedCanonicalEvent,
  sha256Text,
  taskLifecycleWritePlan,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type TaskProjectionPort,
  type TaskProjectionReaderPort,
} from "@harness-anything/kernel";
import {
  createMigrationImportEvent,
  migrationImportWritePlan,
} from "@harness-anything/kernel/internal/domain/migration-import-event.ts";
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

export const HISTORICAL_TIMESTAMP_CASES = Object.freeze([
  { revision: 1, occurredAt: "2026-11-05T00:30:00+08:00", expectedInNov5: false }, // 2026-11-04T16:30:00Z
  { revision: 2, occurredAt: "2026-11-05T00:00:00Z", expectedInNov5: true }, // exact start without .sss
  { revision: 3, occurredAt: "2026-11-04T20:00:00-05:00", expectedInNov5: true }, // 2026-11-05T01:00:00Z
  { revision: 4, occurredAt: "2026-11-06T07:59:59.999+08:00", expectedInNov5: true }, // exact end 2026-11-05T23:59:59.999Z
  { revision: 5, occurredAt: "2026-11-06T08:00:00+08:00", expectedInNov5: false }, // 2026-11-06T00:00:00Z
] as const);

export function buildHistoricalTimestampFixtures(baseEvents: readonly CanonicalEventV1[]): readonly {
  readonly revision: number;
  readonly occurredAt: string;
  readonly eventJson: string;
  readonly digest: string;
}[] {
  return HISTORICAL_TIMESTAMP_CASES.map((entry, idx) => {
    const mutated = { ...baseEvents[idx]!, occurredAt: entry.occurredAt };
    const eventJson = serializePersistedCanonicalEvent(mutated);
    return {
      revision: entry.revision,
      occurredAt: entry.occurredAt,
      eventJson,
      digest: `sha256:${sha256Text(eventJson)}`,
    };
  });
}

export function assertHistoricalDateWindowAndImportParity(input: {
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjectionPort;
  readonly importedTaskId: string;
}): void {
  const { store, projection, importedTaskId } = input;
  assert.ok(store.readEventWindow !== undefined);
  // DM-01 + DM-03: Multi-page date window [2026-11-05T00:00:00.000Z, 2026-11-05T23:59:59.999Z] with limit=2
  const page1 = store.readEventWindow({
    afterRevision: 0,
    after: "2026-11-05T00:00:00.000Z",
    before: "2026-11-05T23:59:59.999Z",
    limit: 2,
  });
  assert.equal(page1.done, false);
  assert.deepEqual(
    page1.events.map((e) => [e.workspaceRevision, e.occurredAt]),
    [
      [2, "2026-11-05T00:00:00Z"],
      [3, "2026-11-04T20:00:00-05:00"],
    ],
  );
  assert.equal(page1.windowMaxRevision, 4);

  const page2 = store.readEventWindow({
    afterRevision: page1.lastScannedRevision,
    maxRevision: page1.windowMaxRevision,
    after: "2026-11-05T00:00:00.000Z",
    before: "2026-11-05T23:59:59.999Z",
    limit: 2,
    boundsPinned: true,
  });
  assert.equal(page2.done, true);
  assert.deepEqual(
    page2.events.map((e) => [e.workspaceRevision, e.occurredAt]),
    [[4, "2026-11-06T07:59:59.999+08:00"]],
  );

  // DM-04: Historically imported done task indexed and readable via readTaskImportedEvent across hot apply & cold rebuild
  const nextRev = (store.readHead()?.revision ?? 0) + 1;
  const baseTask = lifecycleFixture({ taskId: importedTaskId, executionId: "exec_unused" }).snapshot.task!;
  const docBody = "# Imported Done Task\n";
  const docSha = sha256Text(docBody);
  const importEvent = createMigrationImportEvent({
    eventId: `event-import-${importedTaskId}`,
    workspaceRevision: nextRev,
    opId: `migration-import-${importedTaskId}`,
    actor: { principal: { personId: "person-import" }, executor: null },
    source: "migration-import/v1",
    occurredAt: "2026-08-19T02:33:20.837Z",
    payload: {
      migratedFrom: importedTaskId,
      generation: "v0",
      entity: {
        kind: "task",
        provenance: "imported_snapshot",
        task: { ...baseTask, taskId: importedTaskId, status: "done" },
        originalStatus: "done",
        packagePath: `tasks/${importedTaskId}-imported`,
        documentClaim: {
          path: `tasks/${importedTaskId}-imported/INDEX.md`,
          sha256: docSha,
          size: Buffer.byteLength(docBody),
          mediaType: "text/markdown",
          policyId: "typed-migration-import/v1",
        },
      },
    },
  });
  const plan = migrationImportWritePlan(importEvent);
  store.append({
    event: importEvent,
    plan,
    blobs: [{ sha256: docSha, size: Buffer.byteLength(docBody), mediaType: "text/markdown", body: docBody }],
  });
  projection.apply(importEvent, plan);
  assert.equal(projection.read(importedTaskId).snapshot.task?.status, "done");
  assert.equal(projection.readTaskImportedEvent?.(importedTaskId)?.opId, importEvent.opId);
  projection.rebuild();
  assert.equal(projection.readTaskImportedEvent?.(importedTaskId)?.opId, importEvent.opId);
}
