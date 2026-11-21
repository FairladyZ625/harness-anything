// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { assertEntityFactory } from "../entity-factory.assertions.ts";
import { openEntityStore } from "../../src/store/entity-store.ts";
import test from "node:test";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { SQLITE_OCCURRED_AT_DAY_SQL } from "../../src/store/sqlite-event-window.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import {
  assertCanonicalFactoryLifecycle,
  assertHistoricalDateWindowAndImportParity,
  buildHistoricalTimestampFixtures,
  HISTORICAL_TIMESTAMP_CASES,
} from "../canonical-factory.assertions.ts";
import { eventAt } from "./task-event-store.fixtures.ts";
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

test("SQLite readEventWindow handles sub-ms truncation, ±23:59 offsets, equal endpoints, sparse gaps, and readTaskImportedEvent", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoId = "sqlite-dm01-dm04";
    const baseEvents = Array.from({ length: HISTORICAL_TIMESTAMP_CASES.length }, (_, idx) => {
      const ev = eventAt(idx + 1);
      return { ...ev, eventId: `hist-ts-event-${idx + 1}`, opId: `hist-ts-op-${idx + 1}` };
    });
    let store = makeTaskEventStore({ rootDir, repoId });
    for (const ev of baseEvents) {
      store.append({ event: ev, plan: taskLifecycleWritePlan(ev), blobs: [] });
    }
    await store.drain();
    // Simulate historical persisted rows with sub-ms fractions, ±23:59 offsets, and non-ms UTC timestamps
    const db = new DatabaseSync(sqliteLedgerPath(rootDir));
    try {
      const stmt = db.prepare("UPDATE event SET occurred_at=?, event_json=?, digest=? WHERE revision=?");
      for (const row of buildHistoricalTimestampFixtures(baseEvents)) {
        stmt.run(row.occurredAt, row.eventJson, row.digest, row.revision);
      }
      // Verify the SQLite planner uses the expression index event_occurred_at_day_revision (no table scan).
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT event_json FROM event WHERE (${SQLITE_OCCURRED_AT_DAY_SQL})=? AND revision>? AND revision<=? ORDER BY revision ASC LIMIT ?`,
        )
        .all(Math.floor(Date.parse("2026-11-05T00:00:00.000Z") / 86_400_000), 0, 100, 10);
      assert.match(plan.map((row) => String(row.detail)).join("\n"), /USING INDEX event_occurred_at_day_revision/u);
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

test("SQLite readEventWindow sparse date-window pagination skips intervening non-matching revisions in O(matching page)", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoId = "sqlite-dm03-sparse";
    const store = makeTaskEventStore({ rootDir, repoId });
    const matchingBefore = 30;
    const gapSize = 1_500;
    const matchingAfter = 30;
    const batch: ReturnType<typeof eventAt>[] = [];
    for (let rev = 1; rev <= matchingBefore + gapSize + matchingAfter; rev += 1) {
      const inWindow = rev <= matchingBefore || rev > matchingBefore + gapSize;
      const ev = eventAt(rev);
      batch.push({
        ...ev,
        occurredAt: inWindow ? "2026-11-05T12:00:00.000Z" : "2026-11-06T12:00:00.000Z",
      });
    }
    for (let offset = 0; offset < batch.length; offset += 100) {
      const slice = batch.slice(offset, offset + 100).map((event) => ({
        event,
        plan: taskLifecycleWritePlan(event),
        blobs: [] as const,
      }));
      const terminal = slice.pop()!;
      store.append({ ...terminal, preceding: slice });
    }
    try {
      const collected: number[] = [];
      let afterRevision = 0;
      let maxRevision: number | undefined;
      let pages = 0;
      for (;;) {
        const page = store.readEventWindow!({
          afterRevision,
          ...(maxRevision === undefined ? {} : { maxRevision, boundsPinned: true }),
          after: "2026-11-05T00:00:00.000Z",
          before: "2026-11-05T23:59:59.999Z",
          limit: 20,
        });
        pages += 1;
        for (const ev of page.events) collected.push(ev.workspaceRevision);
        maxRevision = page.windowMaxRevision;
        if (page.done) break;
        afterRevision = page.lastScannedRevision;
      }
      assert.equal(pages, 3);
      assert.equal(collected.length, matchingBefore + matchingAfter);
      assert.equal(collected[0], 1);
      assert.equal(collected[matchingBefore - 1], matchingBefore);
      assert.equal(collected[matchingBefore], matchingBefore + gapSize + 1);
      assert.equal(collected.at(-1), matchingBefore + gapSize + matchingAfter);
    } finally {
      await store.drain();
    }
  });
});
