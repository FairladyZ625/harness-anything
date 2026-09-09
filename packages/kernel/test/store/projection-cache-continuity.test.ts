// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import type { EventStreamPort } from "../../src/projection/rebuildable-task-projection-types.ts";
import { makeTaskEventStore, type CanonicalEventStore } from "../../src/store/task-event-store.ts";
import { sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("a real SQLite event gap blocks schema rebuild and preserves the cache bytes", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const writer = makeTaskEventStore({ repoId: "cache-continuity", rootDir }),
      events = lifecycleFixture().events.slice(0, 3);
    let readable: CanonicalEventStore = writer;
    const eventStore: EventStreamPort = {
        readHead: () => readable.readHead(),
        readBatch: (cursor, maxItems) => readable.readBatch(cursor, maxItems),
        readContentBlob: (sha256) => readable.readContentBlob(sha256),
      },
      projection = makeTaskProjection({ rootDir, eventStore });
    for (const event of events) {
      writer.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
      projection.apply(event, taskLifecycleWritePlan(event));
    }
    projection.close();
    const schema = new DatabaseSync(projection.path);
    schema
      .prepare("UPDATE projection_meta SET schema_version = ? WHERE singleton = 1")
      .run(taskProjectionSchemaVersion - 1);
    schema.close();
    const retained = readFileSync(projection.path),
      missingEvent = events[1]!;
    await writer.drain();
    const ledgerPath = sqliteLedgerPath(rootDir, 2),
      ledger = new DatabaseSync(ledgerPath);
    try {
      assert.equal(
        ledger.prepare("DELETE FROM event WHERE revision = ?").run(missingEvent.workspaceRevision).changes,
        1,
      );
    } finally {
      ledger.close();
    }
    readable = makeTaskEventStore({ repoId: "cache-continuity", rootDir, mutable: false });
    t.after(() => readable.drain());

    const rejectsGap = (error: unknown): boolean => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error & { code?: string }).code, "invalid_store");
      assert.deepEqual(
        {
          cacheWatermark: (error as { cacheWatermark?: number }).cacheWatermark,
          cacheScannedRevision: (error as { cacheScannedRevision?: number }).cacheScannedRevision,
          eventStreamHead: (error as { eventStreamHead?: number | null }).eventStreamHead,
          missingRange: (error as { missingRange?: unknown }).missingRange,
        },
        { cacheWatermark: 3, cacheScannedRevision: 3, eventStreamHead: 3, missingRange: { from: 2, to: 2 } },
      );
      return true;
    };
    assert.throws(() => projection.rebuild(), rejectsGap);
    assert.deepEqual(readFileSync(projection.path), retained);
    assert.throws(() => makeTaskProjection({ rootDir, eventStore }), rejectsGap);
    assert.deepEqual(readFileSync(projection.path), retained);
    t.diagnostic(
      JSON.stringify({
        case: "sqlite-event-gap",
        ledgerPath,
        removedRevision: missingEvent.workspaceRevision,
        cacheWatermark: 3,
        eventStreamHead: 3,
        missingRange: { from: 2, to: 2 },
        cacheBytesRetained: retained.byteLength,
      }),
    );
  });
});
