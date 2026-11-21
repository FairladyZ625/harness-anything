// harness-test-tier: integration
import { DatabaseSync } from "node:sqlite";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { assertEntityFactory } from "../entity-factory.assertions.ts";
import { openEntityStore } from "../../src/store/entity-store.ts";
import test from "node:test";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import {
  assertCanonicalFactoryLifecycle,
  assertHistoricalDateWindowAndImportParity,
  buildHistoricalTimestampFixtures,
} from "../canonical-factory.assertions.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { assertWriterEpochFactory } from "../writer-epoch-factory.assertions.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("SQLite synchronous factories satisfy the shared canonical lifecycle contract", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoId = "sqlite-factory",
      store = makeTaskEventStore({ rootDir, repoId }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      assertCanonicalFactoryLifecycle({
        store,
        projection,
        taskId: "task-factory",
        executionId: "execution-factory",
        reader: () => makeTaskProjectionReader({ rootDir }),
      });
      assertEntityFactory({
        store,
        open: () => openEntityStore(rootDir),
        withReadSession: (read) => {
          const reader = makeTaskProjectionReader({ rootDir });
          try {
            reader.withSession(() => read());
          } finally {
            reader.close();
          }
        },
      });
    } finally {
      projection.close();
      await store.drain();
    }
  });
});

test("SQLite writer epoch factories preserve append fencing", async () => {
  await withTempStoreAsync(async (rootDir) => {
    await assertWriterEpochFactory({ rootDir, repoId: "sqlite-epoch" });
  });
});

test("SQLite readEventWindow handles historical timezone offsets/no-ms timestamps and readTaskImportedEvent", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoId = "sqlite-dm01-dm04";
    const baseEvents = lifecycleFixture({ taskId: "task_hist_ts", executionId: "exec_hist_ts" }).events.slice(0, 5);
    let store = makeTaskEventStore({ rootDir, repoId });
    for (const ev of baseEvents) {
      store.append({ event: ev, plan: taskLifecycleWritePlan(ev), blobs: [] });
    }
    await store.drain();
    // Simulate historical persisted rows with +08:00, -05:00, and non-ms UTC timestamps
    const db = new DatabaseSync(sqliteLedgerPath(rootDir));
    try {
      const stmt = db.prepare("UPDATE event SET occurred_at=?, event_json=?, digest=? WHERE revision=?");
      for (const row of buildHistoricalTimestampFixtures(baseEvents)) {
        stmt.run(row.occurredAt, row.eventJson, row.digest, row.revision);
      }
    } finally {
      db.close();
    }
    store = makeTaskEventStore({ rootDir, repoId });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      projection.rebuild();
      assertHistoricalDateWindowAndImportParity({
        store,
        projection,
        importedTaskId: "task_sqlite_imported_done",
      });
    } finally {
      projection.close();
      await store.drain();
    }
  });
});
