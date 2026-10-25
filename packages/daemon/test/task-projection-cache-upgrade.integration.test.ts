// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection, taskLifecycleWritePlan } from "@harness-anything/kernel";
import { canonicalRoot } from "../src/protocol/daemon-protocol.contract.ts";
import { makeTaskQueryReadModel } from "../src/task-query-read.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { initRepo } from "../../kernel/test/store/task-event-store.fixtures.ts";
import { withTempStoreAsync } from "../../kernel/test/store/helpers.ts";

const oldSnapshotSchemaVersion = 37;

/**
 * The cache version that shipped version-38's snapshot-key removal without raising the constant:
 * such a cache announces 38 while its rows still carry `codeDocWitnesses`. Every read isolated them,
 * so the board served a fraction of the ledger (2026-10-25: 92 of 4,469).
 */
const releasedSnapshotSchemaVersion = 38;

test("a schema-38 cache carrying the retired snapshot key serves its rows without a replay", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const taskId = "task-cache-upgrade-38",
      eventStore = makeTaskEventStore({ repoId: "projection-cache-upgrade-38", rootDir }),
      events = lifecycleFixture({ taskId }).events.map((event) => ({
        ...event,
        payload: {
          ...event.payload,
          task: { ...event.payload.task, packageDisposition: "active" as const },
        },
      })),
      original = makeTaskProjection({ rootDir, eventStore });

    for (const event of events) {
      const plan = taskLifecycleWritePlan(event);
      eventStore.append({ event, plan, blobs: [] });
      original.apply(event, plan);
    }
    original.close();

    // A cache written by the build whose constant was 38 while the cleaner was already in place:
    // the retired key is back in the row and the announced version matches the cleaner's own.
    const legacyCache = new DatabaseSync(original.path);
    try {
      const row = legacyCache.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?").get(taskId) as
        | { readonly snapshot_json: string }
        | undefined;
      assert.ok(row);
      const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
      snapshot.codeDocWitnesses = [];
      legacyCache
        .prepare("UPDATE task_snapshot SET snapshot_json = ? WHERE task_id = ?")
        .run(JSON.stringify(snapshot), taskId);
      legacyCache
        .prepare("UPDATE projection_meta SET schema_version = ? WHERE singleton = 1")
        .run(releasedSnapshotSchemaVersion);
    } finally {
      legacyCache.close();
    }

    // No replay may be forced. A schema bump here is what the rejected first cut did, and on a real
    // 3.3 GB cache it made attach unservable: 216-340 s of replay with a 107 s no-progress gap
    // against a 30 s ready-watchdog. The read boundary strips the retired key instead, so this
    // listener must stay silent.
    const discard = t.mock.method(console, "error", () => undefined),
      opened = makeTaskProjection({ rootDir, eventStore });
    try {
      opened.catchUp();
      const result = makeTaskQueryReadModel({
        rootDir: canonicalRoot(rootDir),
        projection: opened,
        readPinnedEntities: () => [],
        judgments: {
          closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
          blocking: (() => []) as never,
        },
      }).guiTasks({ limit: 50 });

      // The regression proper: the row the ledger holds is served, and it is not reported as
      // isolated. Before the read-boundary strip this is `[]` plus one `invalidRows` entry.
      assert.deepEqual(
        result.rows.map(({ taskId: rowTaskId }) => rowTaskId),
        [taskId],
        "a cache carrying the retired snapshot key must serve its rows instead of isolating them",
      );
      assert.deepEqual(result.invalidRows, [], "the retired snapshot key must not isolate the row");
      // Nothing was discarded, so no rebuild was triggered by opening this cache.
      const discarded = discard.mock.calls
        .map((call) => JSON.parse(call.arguments[0] as string) as Record<string, unknown>)
        .filter((entry) => entry.event === "projection_discard_started");
      assert.deepEqual(discarded, [], "opening the cache must not force a replay");
      assert.equal(makeTaskProjection({ rootDir, eventStore }).readCut().watermark, events.length);
    } finally {
      opened.close();
      await eventStore.drain();
    }
  });
});

test("an existing schema-37 cache with retired codeDoc fields rebuilds before guiTasks reads it", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const taskId = "task-cache-upgrade",
      eventStore = makeTaskEventStore({ repoId: "projection-cache-upgrade", rootDir }),
      events = lifecycleFixture({ taskId }).events.map((event) => ({
        ...event,
        payload: {
          ...event.payload,
          task: { ...event.payload.task, packageDisposition: "active" as const },
        },
      })),
      original = makeTaskProjection({ rootDir, eventStore });

    for (const event of events) {
      const plan = taskLifecycleWritePlan(event);
      eventStore.append({ event, plan, blobs: [] });
      original.apply(event, plan);
    }
    original.close();

    const legacyCache = new DatabaseSync(original.path);
    try {
      const row = legacyCache.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?").get(taskId) as
        | { readonly snapshot_json: string }
        | undefined;
      assert.ok(row);
      const snapshot = JSON.parse(row.snapshot_json) as {
        readonly task: Record<string, unknown>;
      };
      // Both retired carriers an older cache can hold: the witness projection and the codeDoc key
      // that this delivery narrowed out of the closeout override vocabulary.
      snapshot.task.closeoutOverrides = { codeDoc: true };
      (snapshot as unknown as Record<string, unknown>).codeDocWitnesses = [];
      legacyCache
        .prepare("UPDATE task_snapshot SET snapshot_json = ? WHERE task_id = ?")
        .run(JSON.stringify(snapshot), taskId);
      legacyCache
        .prepare("UPDATE projection_meta SET schema_version = ? WHERE singleton = 1")
        .run(oldSnapshotSchemaVersion);
    } finally {
      legacyCache.close();
    }

    const discard = t.mock.method(console, "error", () => undefined),
      upgraded = makeTaskProjection({ rootDir, eventStore });
    try {
      upgraded.catchUp();
      const result = makeTaskQueryReadModel({
        rootDir: canonicalRoot(rootDir),
        projection: upgraded,
        readPinnedEntities: () => [],
        judgments: {
          closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
          blocking: (() => []) as never,
        },
      }).guiTasks({ limit: 50 });

      assert.deepEqual(
        result.rows.map(({ taskId: rowTaskId }) => rowTaskId),
        [taskId],
      );
      assert.deepEqual(result.invalidRows, []);
      assert.equal(discard.mock.callCount(), 1);
      const migration = JSON.parse(discard.mock.calls[0]!.arguments[0] as string) as Record<string, unknown>;
      assert.equal(migration.event, "projection_discard_started");
      assert.equal(migration.reason, "schema_mismatch");
      assert.equal(migration.schemaVersion, oldSnapshotSchemaVersion);
      assert.ok(
        Number(migration.supportedSchemaVersion) > oldSnapshotSchemaVersion,
        "the build must support a snapshot version newer than the cache it discards",
      );
      assert.equal(upgraded.readCut().watermark, events.length);
    } finally {
      upgraded.close();
      await eventStore.drain();
    }
  });
});
