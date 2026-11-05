// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";

import { withTempStoreAsync } from "./helpers.ts";

function seed(db: DatabaseSync, count: number): void {
  const insert = db.prepare("INSERT INTO event_index(op_id,workspace_revision,event_json) VALUES(?,?,?)");
  db.exec("BEGIN");
  for (let revision = 1; revision <= count; revision++) {
    insert.run(
      `dispatch-${revision}`,
      revision,
      JSON.stringify({
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        eventId: `event-${revision}`,
        opId: `dispatch-${revision}`,
        workspaceRevision: revision,
        actor: { principal: { personId: "test" }, executor: null },
        source: "local",
        occurredAt: "2026-11-05T00:00:00.000Z",
        payload: {
          dispatchId: `dispatch-${revision}`,
          runtimeSessionId: `session-${revision}`,
          agentId: "agent-test",
          role: "implementer",
          startedAt: "2026-11-05T00:00:00.000Z",
          ...(revision % 2 ? { idempotencyKey: `key-${revision}` } : { dispatchKey: `key-${revision}` }),
        },
      }),
    );
  }
  db.exec("COMMIT");
}

test("100000 events: projection open must not consume historical read-index backfill", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const projectionPath = path.join(rootDir, "projection.sqlite");
    let sourceRevision = 0;
    const eventStore = {
      readHead: () => (sourceRevision === 0 ? null : { revision: sourceRevision }),
      readBatch: () => ({ sourceRevision, events: [], cursor: null, done: true, accessedItems: 0 }),
      readContentBlob: () => null,
    };
    const initial = makeTaskProjection({ rootDir, projectionPath, eventStore });
    initial.readCut();
    initial.close();
    const db = new DatabaseSync(projectionPath);
    try {
      // Reconstruct the immediately previous binary's populated projection: all old columns,
      // indexes, and presence triggers are retained; only the newly introduced key is absent.
      db.exec(`DROP TRIGGER runtime_read_index_event_0; DROP TRIGGER runtime_read_index_event_1;
        DROP TRIGGER runtime_read_index_event_delete; DROP TRIGGER runtime_read_index_session_present;
        DROP TRIGGER runtime_read_index_session_absent; DROP TABLE runtime_dispatch_index; DROP TABLE runtime_read_index_progress`);
      seed(db, 100000);
      sourceRevision = 100000;
      db.exec("UPDATE projection_meta SET watermark=100000,scanned_revision=100000");
    } finally {
      db.close();
    }
    let warmOpenMs: number;
    let applied = 0,
      pages = 0,
      firstPageMs = 0;
    const start = performance.now();
    const projection = makeTaskProjection({
      rootDir,
      projectionPath,
      eventStore,
      onValidationProgress: (progress) => {
        if (pages === 0) firstPageMs = performance.now() - start;
        applied = progress.applied;
        pages++;
      },
    });
    let eventLoopDelayMs = 0;
    const responsiveness = new Promise<void>((resolve) =>
      setImmediate(() => {
        eventLoopDelayMs = performance.now() - start;
        resolve();
      }),
    );
    try {
      const cut = projection.readCut();
      const upgradeOpenMs = performance.now() - start;
      await responsiveness;
      assert.equal(cut.status, "ready");
      const key = projection.readRuntimeDispatchByDispatchKey("key-100000");
      assert.equal(key?.event.payload.dispatchId, "dispatch-100000");
      assert.equal(applied, 0, "opening must never consume a backfill page");
      const opened = new DatabaseSync(projectionPath, { readOnly: true });
      assert.equal(opened.prepare("SELECT revision FROM runtime_read_index_progress").get()!.revision, 0);
      assert.equal(opened.prepare("SELECT count(*) AS n FROM runtime_dispatch_index").get()!.n, 0);
      opened.close();
      const first = projection.backfillReadIndexes!();
      assert.deepEqual(first, { processed: 64, done: false });
      const progressDb = new DatabaseSync(projectionPath, { readOnly: true });
      assert.equal(progressDb.prepare("SELECT revision FROM runtime_read_index_progress").get()!.revision, 64);
      progressDb.close();
      projection.close();
      const warmStart = performance.now();
      const warm = makeTaskProjection({ rootDir, projectionPath, eventStore });
      try {
        assert.equal(warm.readCut().status, "ready");
        warmOpenMs = performance.now() - warmStart;
        const resumed = warm.backfillReadIndexes!();
        assert.deepEqual(resumed, { processed: 64, done: false });
        const inspect = new DatabaseSync(projectionPath, { readOnly: true });
        assert.equal(inspect.prepare("SELECT revision FROM runtime_read_index_progress").get()!.revision, 128);
        assert.equal(warm.readRuntimeDispatchByDispatchKey("key-99999")?.event.payload.dispatchId, "dispatch-99999");
        assert.equal(warm.readRuntimeDispatchByDispatchKey("missing"), null);
        let processed = 128;
        for (;;) {
          const page = warm.backfillReadIndexes!();
          assert.ok(page.processed <= 64);
          processed += page.processed;
          if (page.done) break;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.equal(processed, 100000);
        assert.equal(inspect.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete, 1);
        assert.equal(inspect.prepare("SELECT count(*) AS n FROM runtime_dispatch_index").get()!.n, 100000);
        // Complete readers return the same history after the last batch commits.
        assert.equal(warm.readRuntimeDispatchByDispatchKey("key-100000")?.event.payload.dispatchId, "dispatch-100000");
        assert.deepEqual(warm.backfillReadIndexes!(), { processed: 0, done: true });
        inspect.close();
      } finally {
        warm.close();
      }

      t.diagnostic(
        `PROJECTION_OPEN_SCALE ${JSON.stringify({
          events: sourceRevision,
          upgradeOpenMs,
          warmOpenMs,
          firstPageMs,
          pages,
          applied,
          eventLoopDelayMs,
          readAfter: key?.event.payload.dispatchId,
        })}`,
      );
      assert.equal(applied, 0, "repository projection open synchronously consumed all historical read-index rows");
    } finally {
      projection.close();
    }
  });
});
