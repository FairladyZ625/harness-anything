// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPGlitePool, createPGliteStorage, withPGliteTransaction } from "../../src/pglite/index.ts";
import { resolveStorageBackend } from "../../src/storage-backend.ts";

const claims = { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 7 } as const;

test("PGlite storage persists PostgreSQL transactions and clears local scope claims", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pglite-foundation-"));
  const storage = createPGliteStorage({ dataDir: root });
  try {
    await withPGliteTransaction(
      storage.db,
      async (transaction) => {
        await transaction.query("CREATE TABLE pglite_probe (id text PRIMARY KEY, payload text NOT NULL)");
        const scoped = await transaction.query<{ tenantId: string; projectId: string; policyEpoch: string }>(
          'SELECT current_setting($1) AS "tenantId", current_setting($2) AS "projectId", current_setting($3) AS "policyEpoch"',
          ["ha.tenant_id", "ha.project_id", "ha.policy_epoch"],
        );
        assert.deepEqual(scoped.rows[0], { tenantId: claims.tenantId, projectId: claims.projectId, policyEpoch: "7" });
        await transaction.query("INSERT INTO pglite_probe (id, payload) VALUES ($1, $2)", ["one", "committed"]);
      },
      claims,
    );
    await assert.rejects(
      withPGliteTransaction(storage.db, async (transaction) => {
        await transaction.query("INSERT INTO pglite_probe (id, payload) VALUES ($1, $2)", ["two", "rolled-back"]);
        throw new Error("rollback witness");
      }),
      /rollback witness/u,
    );
    assert.deepEqual((await storage.db.query("SELECT id, payload FROM pglite_probe ORDER BY id")).rows, [
      { id: "one", payload: "committed" },
    ]);
    assert.deepEqual((await storage.db.query("SELECT current_setting('ha.tenant_id', true) AS tenant_id")).rows, [
      { tenant_id: "" },
    ]);
  } finally {
    await storage.close();
  }

  const reopened = createPGliteStorage({ dataDir: root });
  try {
    assert.deepEqual((await reopened.db.query("SELECT payload FROM pglite_probe")).rows, [{ payload: "committed" }]);
  } finally {
    await reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("PGlite node-postgres bridge exposes one connection and the same transaction contract", async () => {
  const pool = createPGlitePool({ dataDir: "memory://ha-pglite-pool-contract" });
  try {
    assert.equal(pool.options.max, 1);
    assert.equal(pool.pglite.closed, false);
    await withPGliteTransaction(
      pool,
      async (client) => {
        await client.query("CREATE TABLE pglite_pool_probe (value integer NOT NULL)");
        await client.query("INSERT INTO pglite_pool_probe VALUES ($1)", [7]);
      },
      claims,
    );
    assert.deepEqual((await pool.query("SELECT value FROM pglite_pool_probe")).rows, [{ value: 7 }]);
  } finally {
    await pool.closePGlite();
  }
  assert.equal(pool.pglite.closed, true);
});

test("PGlite records its deliberate single-user/RLS boundary instead of claiming PG role isolation", async () => {
  const storage = createPGliteStorage({ dataDir: "memory://ha-pglite-capabilities" });
  try {
    const identity = await storage.db.query<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      'SELECT current_user AS "currentUser", rolsuper AS superuser, rolbypassrls AS "bypassRls" FROM pg_roles WHERE rolname = current_user',
    );
    assert.deepEqual(identity.rows[0], { currentUser: "postgres", superuser: true, bypassRls: true });
    await storage.db.exec(
      "CREATE TABLE pglite_rls_probe (tenant_id text NOT NULL, payload text NOT NULL); " +
        "ALTER TABLE pglite_rls_probe ENABLE ROW LEVEL SECURITY; " +
        "ALTER TABLE pglite_rls_probe FORCE ROW LEVEL SECURITY; " +
        "CREATE POLICY pglite_rls_probe_scope ON pglite_rls_probe USING (tenant_id = current_setting('ha.tenant_id', true)) WITH CHECK (tenant_id = current_setting('ha.tenant_id', true));",
    );
    await storage.db.query("INSERT INTO pglite_rls_probe VALUES ($1, $2), ($3, $4)", [
      "tenant-a",
      "visible",
      "tenant-b",
      "superuser-visible",
    ]);
    const rows = await withPGliteTransaction(
      storage.db,
      (transaction) => transaction.query("SELECT tenant_id, payload FROM pglite_rls_probe ORDER BY tenant_id"),
      claims,
    );
    assert.equal(rows.rows.length, 2);
  } finally {
    await storage.close();
  }
});

test("pglite backend config resolves without leaking a PostgreSQL connection string", () => {
  assert.deepEqual(
    resolveStorageBackend({ storage: { backend: "pglite", dataDir: "./studio-pgdata", scope: claims } }),
    {
      backend: "pglite",
      dataDir: "./studio-pgdata",
      scope: claims,
    },
  );
});
