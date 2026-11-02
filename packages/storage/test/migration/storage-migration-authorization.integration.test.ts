// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startManagedPostgresFixture } from "../postgres/managed-postgres.fixture.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../../src/postgres/event-ledger-schema.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { createMigrationGrant } from "../../src/migration/postgres-grant.ts";
import { openPgMigrationEndpoint } from "../../src/migration/postgres-endpoint.ts";
import { openSqliteMigrationEndpoint } from "../../src/migration/sqlite-endpoint.ts";
import { migrateStorage } from "../../src/migration/engine.ts";
import { bundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";

test("real PG: session_user grant prevents claims/run-id spoofing and grants expire; three lossy rollbacks fail before freeze", async () => {
  const fixture = await startManagedPostgresFixture(),
    root = mkdtempSync(path.join(tmpdir(), "ha-migration-auth-")),
    scope = { tenantId: "tenant-a", projectId: "project-a", readers: [], policyEpoch: 0 };
  try {
    await withPostgresTransaction(fixture.adminPool, async (client) => {
      for (const sql of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await client.query(sql);
      await ensurePgProjectionSchema(client);
    });
    for (const [repoId, s] of [
      ["multiple", scope],
      ["multiple", { ...scope, tenantId: "tenant-b" }],
      ["readers", { ...scope, projectId: "project-readers", readers: ["reader-a"] }],
      ["policy", { ...scope, projectId: "project-policy", policyEpoch: 1 }],
    ] as const) {
      await createPgStorageBackend({ pool: fixture.adminPool, repoId, scope: s }).eventStore.append(
        bundle(eventAt(1)),
        0,
        { repoId, holderId: "seed", epoch: 1 },
      );
    }
    const grant = await createMigrationGrant(fixture.adminPool, "authorized-run", [scope]);
    try {
      const role = (await grant.pool.query("SELECT session_user,current_user")).rows[0];
      assert.equal(role.session_user, grant.role);
      await withPostgresTransaction(grant.pool, async (client) => {
        await client.query(
          "SELECT set_config('ha.tenant_id','tenant-b',true),set_config('ha.project_id','project-a',true),set_config('ha.policy_epoch','0',true),set_config('ha.run_id','forged-run',true)",
        );
        assert.deepEqual((await client.query("SELECT DISTINCT tenant_id FROM ha_events ORDER BY tenant_id")).rows, [
          { tenant_id: "tenant-a" },
        ]);
        await assert.rejects(
          client.query(
            "INSERT INTO ha_migration_grants VALUES('forged','run','tenant-b','project-a',now()+interval '1 hour')",
          ),
          { code: "42501" },
        );
      }).catch((error) => {
        if ((error as { code?: string }).code !== "25P02") throw error;
      });
      await assert.rejects(grant.pool.query("SET SESSION AUTHORIZATION postgres"), { code: "42501" });
      await assert.rejects(grant.pool.query("SET ROLE postgres"), { code: "42501" });
      await assert.rejects(
        grant.pool.query(
          "INSERT INTO ha_repo_heads(tenant_id,project_id,repo_id,policy_epoch) VALUES('tenant-a','project-a','forged',0)",
        ),
        { code: "42501" },
      );
      await fixture.adminPool.query(
        "UPDATE ha_migration_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE role_name=$1",
        [grant.role],
      );
      assert.equal((await grant.pool.query("SELECT * FROM ha_events")).rows.length, 0);
      const nextGrant = await createMigrationGrant(fixture.adminPool, "next-run-reaps-crash", [scope]);
      try {
        assert.equal(
          (await fixture.adminPool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [grant.role])).rows.length,
          0,
        );
      } finally {
        await nextGrant.close();
      }
      process.stdout.write(
        "MIGRATION_GRANT session_user/claims/run_id/role-switch/write-grant/expiry negatives passed\n",
      );
    } finally {
      await grant.close();
    }
    for (const [repoId, sourceScope, code] of [
      ["multiple", scope, "storage_migration_multiple_tuples"],
      ["readers", { ...scope, projectId: "project-readers", readers: ["reader-a"] }, "storage_migration_readers"],
      ["policy", { ...scope, projectId: "project-policy", policyEpoch: 1 }, "storage_migration_policy_epoch"],
    ] as const) {
      const targetRoot = path.join(root, repoId);
      mkdirSync(targetRoot);
      initRepo(targetRoot);
      const source = await openPgMigrationEndpoint({ pool: fixture.adminPool, repoId, scope: sourceScope }),
        target = openSqliteMigrationEndpoint({ rootDir: targetRoot, role: "target", repoId, scope });
      try {
        await assert.rejects(
          migrateStorage({
            repoId,
            runId: `refuse-${repoId}`,
            source,
            target,
            exportDirectory: path.join(root, `export-${repoId}`),
          }),
          { code },
        );
        assert.equal(await source.state(), null);
        assert.equal(await target.state(), null);
        process.stdout.write(`MIGRATION_PG_REFUSAL ${code}: source remains writable\n`);
      } finally {
        await target.close();
      }
    }
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
