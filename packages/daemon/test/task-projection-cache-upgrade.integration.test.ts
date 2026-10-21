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

test("an existing schema-37 cache with codeDocWitnesses rebuilds before guiTasks reads it", async (t) => {
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
      const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
      snapshot.codeDocWitnesses = [];
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
      assert.equal(migration.supportedSchemaVersion, 38);
      assert.equal(upgraded.readCut().watermark, events.length);
    } finally {
      upgraded.close();
      await eventStore.drain();
    }
  });
});
