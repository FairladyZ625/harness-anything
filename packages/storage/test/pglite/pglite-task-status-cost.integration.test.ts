// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { withTempStoreAsync } from "../store/helpers.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertTaskStatusCost } from "../postgres/pg-task-status-cost.fixture.ts";

pgliteIntegrationSuite("PGlite task status read costs", () => {
  test("raw and presentation task reads exclude unrelated task history", async () => {
    await withTempStoreAsync(async (root) => {
      const options = {
        repoId: "task-status-cost",
        storage: {
          backend: "pglite" as const,
          dataDir: join(root, "parent-resume"),
          scope: { tenantId: "task-status-cost", projectId: "task-status-cost", policyEpoch: 1 },
        },
      };
      let backend = await createPGliteStorageBackend(options);
      try {
        await assertTaskStatusCost(backend.pool, backend.pool, "pglite");
        await backend.pool.query(`UPDATE ha_task_snapshots SET parent_index_version=0
        WHERE project_id='task-status-cost' AND task_id IN
          (SELECT task_id FROM ha_task_snapshots WHERE project_id='task-status-cost' ORDER BY task_id LIMIT 130)`);
        const pendingPage = await backend.projection.list({ presentationStatus: true, limit: 1 });
        assert.equal(pendingPage.rows.length, 1);
        assert.deepEqual(pendingPage.warnings, ["task_parent_metadata_deferred"]);
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 64, done: false });
        await backend.close();
        backend = await createPGliteStorageBackend(options);
        assert.equal(
          (
            await backend.pool.query(`SELECT count(*)::integer AS n FROM ha_task_snapshots
          WHERE project_id='task-status-cost' AND parent_index_version=0`)
          ).rows[0]!.n,
          66,
          "reopening preserves progress and does not drain the remaining parent pages",
        );
        const resumed = await backend.projection.read("target", true);
        assert.equal(resumed.snapshot.task?.taskId, "target");
        assert.deepEqual(resumed.warnings, ["task_parent_metadata_deferred"]);
        assert.equal((await backend.projection.list({ presentationStatus: true, limit: 1 })).rows.length, 1);
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 64, done: false });
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 2, done: false });
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
        assert.equal((await backend.projection.read("target", true)).snapshot.task?.status, "planned");
        assert.equal((await backend.projection.list({ presentationStatus: true, limit: 1 })).rows.length, 1);
      } finally {
        await backend.close();
      }
    });
  });
});
