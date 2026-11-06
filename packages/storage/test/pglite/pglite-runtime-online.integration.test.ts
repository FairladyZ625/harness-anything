// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { initializePGliteReadSchema } from "../../src/pglite/read-index-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

const scope = { tenantId: "runtime-online", projectId: "runtime-online", policyEpoch: 1 },
  repoId = "runtime-online";
pgliteIntegrationSuite("runtime current-set migration", () => {
  test("100k settled sessions never block attach or become falsely active", async (t) => {
    const backend = await createPGliteStorageBackend({ repoId, storage: { backend: "pglite", scope } });
    const size = 100000,
      keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
    try {
      await backend.pool.query(
        `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision,artifact_index_version)
        VALUES($1,$2,$3,5,$4,$4,1)`,
        [...keys, size],
      );
      await backend.pool.query("ALTER TABLE ha_projection_values DISABLE TRIGGER USER");
      await backend.pool.query(
        `INSERT INTO ha_projection_values(tenant_id,project_id,policy_epoch,model,owner_id,entity_id,workspace_revision,value)
        SELECT $1,$2,$3,'runtime-session','','session-'||lpad(n::text,6,'0'),n,
        jsonb_build_object('runtimeSessionId','session-'||lpad(n::text,6,'0'),
          'liveness',CASE WHEN n=$4 THEN 'live' ELSE 'exited' END,'outcome',CASE WHEN n=$4 THEN NULL ELSE 'succeeded' END,
          'taskBindings',jsonb_build_array(jsonb_build_object('taskId','target','executionId','execution')))::text
        FROM generate_series(1,$4::integer)n`,
        [...keys, size],
      );
      await backend.pool.query("ALTER TABLE ha_projection_values ENABLE TRIGGER USER");
      await backend.pool.query("CREATE TEMP TABLE runtime_attach_writes(n integer)");
      await backend.pool.query(`CREATE FUNCTION pg_temp.count_runtime_write() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN INSERT INTO runtime_attach_writes VALUES(1); RETURN NEW; END $f$`);
      for (const table of ["ha_runtime_unsettled", "ha_projection_values"])
        await backend.pool.query(`CREATE TRIGGER count_runtime_write AFTER INSERT OR UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION pg_temp.count_runtime_write()`);
      const start = performance.now();
      await withPostgresTransaction(backend.pool, initializePGliteReadSchema);
      await withPostgresTransaction(backend.pool, initializePGliteReadSchema);
      const repeatedAttachMs = performance.now() - start;
      assert.equal(Number((await backend.pool.query("SELECT count(*) n FROM runtime_attach_writes")).rows[0]!.n), 0);
      for (const table of ["ha_runtime_unsettled", "ha_projection_values"])
        await backend.pool.query(`DROP TRIGGER count_runtime_write ON ${table}`);
      const completeScope = { ...scope, projectId: "already-complete" };
      await backend.pool.query(
        `INSERT INTO ha_projection_values(tenant_id,project_id,policy_epoch,model,owner_id,entity_id,workspace_revision,value)
        VALUES($1,$2,$3,'runtime-session','','complete',1,'{"runtimeSessionId":"complete","outcome":null,"liveness":"live","taskBindings":[]}')`,
        [completeScope.tenantId, completeScope.projectId, completeScope.policyEpoch],
      );
      const completeReader = createPgTaskProjectionSource({
        pool: backend.pool,
        scope: completeScope,
        repoId,
        ownsPool: false,
      });
      assert.equal(
        (await completeReader.readRuntimeSessions({ inFlightOnly: true })).length,
        1,
        "complete scope stays available while another scope migrates",
      );
      const queries = [
        () => backend.projection.readRuntimeSessions({ inFlightOnly: true }),
        () => backend.projection.readRuntimeSessions({ unsettledOnly: true }),
        () => backend.projection.readRuntimeSessions({ executionOwnerNodeId: "node" }),
        () => backend.projection.readRuntimeSessionsForTask("target"),
        () => backend.projection.readRuntimeSessionPage({ taskId: "target", limit: 1 }),
      ];
      for (const read of queries) await assert.rejects(read(), { code: "projection_pending", message: /progress/u });
      assert.equal((await backend.projection.readRuntimeSessions({ runtimeSessionId: "session-100000" })).length, 1);
      assert.equal((await backend.projection.readRuntimeSessionPage({ limit: 1 })).rows.length, 1);
      assert.deepEqual(await backend.backfillReadIndexes(), { processed: 64, done: false });
      const next = (
        await backend.pool.query(
          "SELECT entity_id FROM ha_projection_values WHERE read_index_version<3 ORDER BY entity_id LIMIT 1",
        )
      ).rows[0]!.entity_id;
      await withPostgresTransaction(backend.pool, initializePGliteReadSchema);
      assert.equal(
        (
          await backend.pool.query(
            "SELECT entity_id FROM ha_projection_values WHERE read_index_version<3 ORDER BY entity_id LIMIT 1",
          )
        ).rows[0]!.entity_id,
        next,
      );
      // A previous writer's original-column update maintains the new index, including keys ahead of the cursor.
      await backend.pool.query("UPDATE ha_projection_values SET value=value WHERE entity_id='session-100000'");
      let units = 64,
        turns = 0;
      for (;;) {
        const page = await backend.backfillReadIndexes();
        assert.ok(page.processed <= 64);
        units += page.processed;
        if (page.done) break;
        assert.ok(++turns < 1600);
      }
      assert.equal(units, size - 1);
      assert.deepEqual(
        (await backend.projection.readRuntimeSessions({ inFlightOnly: true })).map((s) => s.runtimeSessionId),
        ["session-100000"],
      );
      assert.deepEqual(
        (await backend.projection.readRuntimeSessions({ unsettledOnly: true })).map((s) => s.runtimeSessionId),
        ["session-100000"],
      );
      assert.equal((await backend.projection.readRuntimeSessionPage({ taskId: "target", limit: 1 })).rows.length, 1);
      assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
      t.diagnostic(`RUNTIME_ONLINE ${JSON.stringify({ size, repeatedAttachMs, attachWrites: 0, units, turns })}`);
    } finally {
      await backend.close();
    }
  });
});
