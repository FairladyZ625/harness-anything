// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { PG_PROJECTION_SCHEMA_VERSION } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("PGlite task package disposition read default", () => {
  test("a stored snapshot without packageDisposition reads as active", async () => {
    const repoId = "package-disposition-default",
      scope = { tenantId: repoId, projectId: repoId, policyEpoch: 1 },
      taskId = "task_imported_without_disposition",
      snapshot = lifecycleFixture({ taskId }).snapshot,
      oldShape = { ...snapshot, task: { ...snapshot.task!, packageDisposition: undefined } },
      backend = await createPGliteStorageBackend({ repoId, storage: { backend: "pglite", scope } });
    try {
      await withPostgresTransaction(
        backend.pool,
        async (client) => {
          await client.query(
            `INSERT INTO ha_task_snapshots
        (tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
        VALUES($1,$2,$3,$4,1,$5::jsonb)`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, taskId, JSON.stringify(oldShape)],
          );
          await client.query(
            `INSERT INTO ha_repo_heads
        (tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
        VALUES($1,$2,$3,$4,1,'fixture','fixture','fixture')`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
          );
          await client.query(
            `INSERT INTO ha_projection_meta
        (tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
        VALUES($1,$2,$3,$4,1,1)`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, PG_PROJECTION_SCHEMA_VERSION],
          );
        },
        scope,
      );
      const source = createPgTaskProjectionSource({ pool: backend.pool, scope, repoId, ownsPool: false }),
        list = await source.list(),
        read = await source.read(taskId);
      assert.equal(list.rows.length, 1);
      assert.equal(list.rows[0]!.snapshot.task!.packageDisposition, "active");
      assert.equal(read.snapshot.task!.packageDisposition, "active");
      // The read concludes; the stored jsonb still has no disposition field.
      const stored = await withPostgresTransaction(
        backend.pool,
        async (client) =>
          (
            await client.query<{ snapshot: { task: Record<string, unknown> } }>(
              "SELECT snapshot FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$4",
              [scope.tenantId, scope.projectId, scope.policyEpoch, taskId],
            )
          ).rows[0]!.snapshot,
        scope,
      );
      assert.equal(Object.hasOwn(stored.task, "packageDisposition"), false);
    } finally {
      await backend.close();
    }
  });
});
