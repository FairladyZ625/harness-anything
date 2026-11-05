// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("runtime unsettled RLS", () => {
  test("the derived current-set table keeps forced RLS and the scope policy", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "ha-runtime-unsettled-rls-"));
    const backend = await createPGliteStorageBackend({
      repoId: "rls-check",
      storage: {
        backend: "pglite",
        dataDir,
        materialize: false,
        scope: { tenantId: "t", projectId: "p", policyEpoch: 0 },
      },
    });
    try {
      const relation = (
        await backend.pool.query(
          "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='ha_runtime_unsettled'::regclass",
        )
      ).rows[0];
      assert.deepEqual(relation, { relrowsecurity: true, relforcerowsecurity: true });
      const policies = (
        await backend.pool.query(
          "SELECT polname, polqual IS NOT NULL AS has_using, polwithcheck IS NOT NULL AS has_check FROM pg_policy WHERE polrelid='ha_runtime_unsettled'::regclass",
        )
      ).rows;
      assert.ok(
        policies.some(
          (policy) => policy.polname === "ha_runtime_unsettled_scope_policy" && policy.has_using && policy.has_check,
        ),
      );

      // Scope isolation under a real non-owner role, not just the query's own WHERE.
      await backend.pool.query(
        "SELECT set_config('ha.tenant_id','t',false), set_config('ha.project_id','p',false), set_config('ha.policy_epoch','0',false)",
      );
      await backend.pool.query(
        "INSERT INTO ha_runtime_unsettled(tenant_id,project_id,policy_epoch,readers,entity_id,value) VALUES ('t','p',0,'{}','session-1','{}')",
      );
      const role = "ha_runtime_unsettled_test";
      await backend.pool.query(`DROP ROLE IF EXISTS ${role}`);
      await backend.pool.query(`CREATE ROLE ${role} NOBYPASSRLS`);
      await backend.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await backend.pool.query(`GRANT SELECT, INSERT ON ha_runtime_unsettled TO ${role}`);
      await backend.pool.query(`SET ROLE ${role}`);
      const crossScope = (
        await backend.pool.query(
          "SELECT set_config('ha.tenant_id','other',false), set_config('ha.project_id','other',false), set_config('ha.policy_epoch','0',false)",
        )
      ).rows[0];
      assert.ok(crossScope);
      assert.equal(
        (await backend.pool.query("SELECT count(*)::int AS count FROM ha_runtime_unsettled")).rows[0].count,
        0,
      );
      await assert.rejects(
        () =>
          backend.pool.query(
            "INSERT INTO ha_runtime_unsettled(tenant_id,project_id,policy_epoch,readers,entity_id,value) VALUES ('t','p',0,'{}','session-2','{}')",
          ),
        /row-level security policy/u,
      );
      await backend.pool.query("SELECT set_config('ha.tenant_id','t',false), set_config('ha.project_id','p',false)");
      assert.equal(
        (await backend.pool.query("SELECT count(*)::int AS count FROM ha_runtime_unsettled")).rows[0].count,
        1,
      );
      await backend.pool.query("RESET ROLE");
    } finally {
      await backend.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
