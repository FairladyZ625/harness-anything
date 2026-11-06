import type { PoolClient } from "pg";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../postgres/event-ledger-schema.ts";
import { ensurePgProjectionSchema, projectionDdl } from "../pg/pg-projection-schema.ts";

const indexPattern = /^CREATE INDEX IF NOT EXISTS ([a-z0-9_]+)\s+ON ([a-z0-9_]+)/u;

/** Expand only at attach. Existing relation OIDs, constraints, grants and triggers stay intact. */
export async function initializePGliteReadSchema(client: PoolClient): Promise<void> {
  for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) {
    if (indexPattern.test(statement)) continue;
    if (statement.startsWith("CREATE POLICY ")) {
      const match = /^CREATE POLICY "([a-z0-9_]+)" ON "([a-z0-9_]+)"/u.exec(statement)!;
      await client.query(`DO $policy$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='${match[2]}' AND policyname='${match[1]}')
        THEN ${statement}; END IF; END $policy$`);
    } else await client.query(statement);
  }
  await ensurePgProjectionSchema(client, { indexBuild: "deferred" });
  const existing = new Set(
    (
      await client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()")
    ).rows.map((row) => row.indexname),
  );
  for (const sql of new Set([...POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS, ...projectionDdl()])) {
    const match = indexPattern.exec(sql);
    if (!match || existing.has(match[1]!)) continue;
    const [, name, table] = match;
    if (!(await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length) {
      await client.query(sql);
    } else {
      await client.query(
        `INSERT INTO ha_read_index_build(index_name,table_name,statement)
        VALUES($1,$2,$3) ON CONFLICT(index_name) DO UPDATE SET statement=excluded.statement,complete=false`,
        [name, table, sql],
      );
    }
  }
}

/** One physical index per writer turn; PostgreSQL cannot page a B-tree build.
 * PGlite has one connection, so this statement occupies it until completion. Row backfill
 * remains a separate 64-row operation. No table copy, rename or foreign-key rebinding.
 */
export async function backfillPGliteIndexPage(client: PoolClient): Promise<{ processed: number; done: boolean }> {
  const job = (
    await client.query<{ index_name: string; statement: string }>(
      "SELECT index_name,statement FROM ha_read_index_build WHERE NOT complete ORDER BY index_name LIMIT 1",
    )
  ).rows[0];
  if (!job) return { processed: 0, done: true };
  await client.query(job.statement);
  await client.query("UPDATE ha_read_index_build SET complete=true WHERE index_name=$1", [job.index_name]);
  return { processed: 0, done: false };
}
