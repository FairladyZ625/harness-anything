// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { assertEntityFactory } from "../entity-factory.assertions.ts";
import { openEntityStore } from "../../src/store/entity-store.ts";
import test from "node:test";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { SQLITE_OCCURRED_AT_MS_SQL } from "../../src/store/sqlite-event-window.ts";
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
      // Verify the SQLite planner uses the expression index event_occurred_at_ms_revision (no table scan).
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT (${SQLITE_OCCURRED_AT_MS_SQL}) AS ms, revision FROM event ` +
            `WHERE (${SQLITE_OCCURRED_AT_MS_SQL})>=? AND (${SQLITE_OCCURRED_AT_MS_SQL})<=? ` +
            "AND revision>? AND revision<=? " +
            `ORDER BY (${SQLITE_OCCURRED_AT_MS_SQL}) ASC, revision ASC LIMIT ?`,
        )
        .all(Date.parse("2026-11-05T00:00:00.000Z"), Date.parse("2026-11-05T23:59:59.999Z"), 0, 100, 10);
      assert.match(
        plan.map((row) => String(row.detail)).join("\n"),
        /USING COVERING INDEX event_occurred_at_ms_revision/u,
      );
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
      let continuation: string | undefined;
      let pages = 0;
      for (;;) {
        const page = store.readEventWindow!({
          afterRevision,
          ...(maxRevision === undefined ? {} : { maxRevision }),
          ...(continuation === undefined ? {} : { continuation }),
          after: "2026-11-05T00:00:00.000Z",
          before: "2026-11-05T23:59:59.999Z",
          limit: 20,
        });
        pages += 1;
        for (const ev of page.events) collected.push(ev.workspaceRevision);
        maxRevision = page.windowMaxRevision;
        continuation = page.continuation;
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

test("SQLite readEventWindow handles narrow intra-day, >32-day wide windows, and non-monotonic timestamps in revision ASC order", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoId = "sqlite-dm03-narrow-wide";
    const store = makeTaskEventStore({ rootDir, repoId });
    const baseMs = Date.parse("2026-09-01T10:00:00.000Z");
    const dayMs = 86_400_000;
    const allEvents: ReturnType<typeof eventAt>[] = [];
    let rev = 1;
    // 40 active UTC days (> 32 days) with interleaved non-matching out-of-window events and non-monotonic timestamps.
    for (let day = 0; day < 40; day += 1) {
      // Non-monotonic pair inside each day (rev+1 has earlier timestamp than rev)
      const dayStart = baseMs + day * dayMs;
      allEvents.push({
        ...eventAt(rev),
        occurredAt: new Date(dayStart + 30_000).toISOString(),
      });
      rev += 1;
      allEvents.push({
        ...eventAt(rev),
        occurredAt: new Date(dayStart + 10_000).toISOString(),
      });
      rev += 1;
      // Same-day non-matching events outside the 10:00..10:05 narrow window (at 18:00) + out-of-range events in Nov
      for (let g = 0; g < 10; g += 1) {
        allEvents.push({
          ...eventAt(rev),
          occurredAt: day === 0 ? "2026-09-01T18:00:00.000Z" : "2026-11-20T12:00:00.000Z",
        });
        rev += 1;
      }
    }
    for (let offset = 0; offset < allEvents.length; offset += 100) {
      const slice = allEvents.slice(offset, offset + 100).map((event) => ({
        event,
        plan: taskLifecycleWritePlan(event),
        blobs: [] as const,
      }));
      const terminal = slice.pop()!;
      store.append({ ...terminal, preceding: slice });
    }
    try {
      // 1) Wide >32-day window across all 40 active days: must return strictly revision ASC order!
      const wideRevs: number[] = [];
      let afterRevision = 0;
      let maxRevision: number | undefined;
      let continuation: string | undefined;
      for (;;) {
        const page = store.readEventWindow!({
          afterRevision,
          ...(maxRevision === undefined ? {} : { maxRevision }),
          ...(continuation === undefined ? {} : { continuation }),
          after: "2026-09-01T00:00:00.000Z",
          before: "2026-10-10T23:59:59.999Z",
          limit: 17,
        });
        for (const ev of page.events) wideRevs.push(ev.workspaceRevision);
        maxRevision = page.windowMaxRevision;
        continuation = page.continuation;
        if (page.done) break;
        afterRevision = page.lastScannedRevision;
      }
      // 40 days * 2 matching + 10 same-day 18:00 events on day 0 = 90 events, strictly ascending revision
      assert.equal(wideRevs.length, 90);
      for (let i = 1; i < wideRevs.length; i += 1) {
        assert.ok(wideRevs[i]! > wideRevs[i - 1]!, `expected strictly ascending revisions: ${wideRevs.join(",")}`);
      }

      // 2) Narrow intra-day window on 2026-09-01 [10:00:00, 10:05:00]: excludes the 10 same-day 18:00 events!
      const narrow = store.readEventWindow!({
        afterRevision: 0,
        after: "2026-09-01T10:00:00.000Z",
        before: "2026-09-01T10:05:00.000Z",
        limit: 10,
      });
      assert.equal(narrow.done, true);
      assert.deepEqual(
        narrow.events.map((e) => e.workspaceRevision),
        [1, 2],
      );
    } finally {
      await store.drain();
    }
  });
});
