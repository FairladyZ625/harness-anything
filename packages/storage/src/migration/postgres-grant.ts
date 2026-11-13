import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { PostgresEventStoreScope } from "../postgres/pg-event-store.ts";
import { POSTGRES_EVENT_LEDGER_TABLES } from "../postgres/event-ledger-schema.ts";
import { PG_PROJECTION_TABLES } from "../pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";

const tables = [...POSTGRES_EVENT_LEDGER_TABLES, ...PG_PROJECTION_TABLES];
async function removeGrant(client: PoolClient, role: string) {
  if (!/^ha_migration_[a-f0-9]{32}$/u.test(role)) throw new Error("invalid persisted migration login name");
  await client.query("DELETE FROM ha_migration_grants WHERE role_name=$1", [role]);
  for (const table of tables) {
    await client.query(`DROP POLICY IF EXISTS "${role}_read" ON ${table}`);
    await client.query(`DROP POLICY IF EXISTS "${role}_bound" ON ${table}`);
  }
  await client.query(`DROP POLICY IF EXISTS "${role}" ON ha_migration_grants`);
  if ((await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows.length) {
    await client.query(`DROP OWNED BY "${role}"`);
    await client.query(`DROP ROLE "${role}"`);
  }
}
/** CH20: the authorized Action's management connection mints a read-only login, never a caller-selected claim. */
export async function createMigrationGrant(
  admin: Pool,
  runId: string,
  scopes: readonly PostgresEventStoreScope[],
  expiresAt = new Date(Date.now() + 3600_000).toISOString(),
) {
  const role = `ha_migration_${randomUUID().replaceAll("-", "")}`,
    password = randomBytes(32).toString("hex"),
    predicate = `EXISTS (SELECT 1 FROM ha_migration_grants g WHERE g.role_name=session_user AND g.tenant_id=tenant_id AND g.project_id=project_id AND g.expires_at>clock_timestamp())`;
  await withPostgresTransaction(admin, async (client) => {
    await client.query(
      /* @gate-identity state-store/migration.source.storage.src.migration.postgres-grant.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_migration_grants(role_name text NOT NULL, run_id text NOT NULL, tenant_id text NOT NULL, project_id text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(role_name,tenant_id,project_id))`,
    );
    await client.query("ALTER TABLE ha_migration_grants ENABLE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE ha_migration_grants FORCE ROW LEVEL SECURITY");
    // An interrupted exporter cannot run finally. Expiry revokes reads immediately; the next management
    // entry reaps its login and policies without a background timer or a host service.
    const expired = await client.query<{ role_name: string }>(
      "SELECT role_name FROM ha_migration_grants GROUP BY role_name HAVING max(expires_at)<=clock_timestamp()",
    );
    for (const row of expired.rows) await removeGrant(client, row.role_name);
    await client.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS VALID UNTIL '${expiresAt.replaceAll("'", "''")}'`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(`GRANT SELECT ON ha_migration_grants, ${tables.join(",")} TO "${role}"`);
    await client.query(`GRANT EXECUTE ON FUNCTION ha_is_lsn_sync_confirmed(pg_lsn) TO "${role}"`);
    await client.query(
      `CREATE POLICY "${role}" ON ha_migration_grants FOR SELECT TO "${role}" USING(role_name=session_user)`,
    );
    for (const table of tables) {
      const condition = predicate
        .replace("g.tenant_id=tenant_id", `g.tenant_id=${table}.tenant_id`)
        .replace("g.project_id=project_id", `g.project_id=${table}.project_id`);
      await client.query(`CREATE POLICY "${role}_read" ON ${table} FOR SELECT TO "${role}" USING(${condition})`);
      // A restrictive policy defeats the existing permissive claims policy even if the login changes every GUC.
      await client.query(
        `CREATE POLICY "${role}_bound" ON ${table} AS RESTRICTIVE FOR SELECT TO "${role}" USING(${condition})`,
      );
    }
    for (const scope of scopes)
      await client.query("INSERT INTO ha_migration_grants VALUES($1,$2,$3,$4,$5)", [
        role,
        runId,
        scope.tenantId,
        scope.projectId,
        expiresAt,
      ]);
  });
  const options = {
    ...admin.options,
    user: role,
    password,
    max: 1,
    connectionTimeoutMillis: storageReadPolicy.defaultValue.deadlines.migrationConnect,
    statement_timeout: storageReadPolicy.defaultValue.deadlines.migrationStatement,
  };
  if (options.connectionString) {
    const connection = new URL(options.connectionString);
    connection.username = role;
    connection.password = password;
    options.connectionString = connection.href;
  }
  const pool = new Pool(options);
  return {
    pool,
    role,
    async close() {
      await pool.end();
      await withPostgresTransaction(admin, (client) => removeGrant(client, role));
    },
  };
}
