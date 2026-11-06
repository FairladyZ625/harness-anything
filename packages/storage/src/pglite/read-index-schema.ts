import type { PoolClient } from "pg";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../postgres/event-ledger-schema.ts";
import { ensurePgProjectionSchema, projectionDdl } from "../pg/pg-projection-schema.ts";
import { contractPgEventSummaryIndex } from "../pg/pg-event-read-index-migration.ts";

interface IndexJob {
  table_name: string;
  staging: string;
  retired: string;
  columns: string[];
  keys: string[];
  indexes: { name: string; staged: string }[];
  cursor: unknown[] | null;
  upper_bound: unknown[];
}
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const indexPattern = /^CREATE INDEX IF NOT EXISTS ([a-z0-9_]+)\s+ON ([a-z0-9_]+)/u;

/** PGlite has one connection: build trees on empty tables, then feed them bounded pages.
 * The original relation serves readers/writers until an atomic rename. Retain its previous
 * generation through the expand/contract window; reclaim it no later than 2026-12-05.
 */
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
  // Match the schema owner's existing contraction rule before scheduling trees:
  // a retired summary pending index must not restart a completed copy on every open.
  const summariesComplete = await contractPgEventSummaryIndex(client, { indexBuild: "isolated" });
  await client.query(`CREATE TABLE IF NOT EXISTS ha_pglite_index_backfill (
    table_name text PRIMARY KEY, staging text NOT NULL, retired text NOT NULL,
    columns text[] NOT NULL, keys text[] NOT NULL, indexes jsonb NOT NULL,
    cursor jsonb, upper_bound jsonb NOT NULL, complete boolean NOT NULL DEFAULT false)`);
  const statements = [...POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS, ...projectionDdl()],
    candidates = new Map<string, { name: string; sql: string }[]>();
  for (const sql of statements) {
    const match = indexPattern.exec(sql);
    if (!match) continue;
    if (match[1] === "ha_events_summary_pending" && summariesComplete) continue;
    const bucket = candidates.get(match[2]!) ?? [];
    bucket.push({ name: match[1]!, sql });
    candidates.set(match[2]!, bucket);
  }
  const existing = new Set(
    (
      await client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()")
    ).rows.map((row) => row.indexname),
  );
  for (const [table, indexes] of candidates) {
    const missing = indexes.filter((index) => !existing.has(index.name));
    if (!missing.length) continue;
    if (
      (await client.query("SELECT 1 FROM ha_pglite_index_backfill WHERE table_name=$1 AND NOT complete", [table])).rows
        .length
    )
      continue;
    if (!(await client.query(`SELECT 1 FROM ${identifier(table)} LIMIT 1`)).rows.length) {
      for (const index of missing) await client.query(index.sql);
    } else await stageIndexes(client, table, missing);
  }
}

async function stageIndexes(client: PoolClient, table: string, missing: readonly { name: string; sql: string }[]) {
  const oid = (await client.query<{ oid: number }>("SELECT $1::regclass::oid AS oid", [table])).rows[0]!.oid,
    staging = `ha_build_${oid}`,
    retired = `ha_retired_${oid}`,
    fields = (
      await client.query<{ attname: string; attgenerated: string }>(
        "SELECT attname,attgenerated FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",
        [table],
      )
    ).rows,
    columns = fields.filter((field) => !field.attgenerated).map((field) => field.attname),
    constraints = (
      await client.query<{ conname: string; contype: string; definition: string; keys: string[] }>(
        `SELECT conname,contype,pg_get_constraintdef(oid) AS definition,
        ARRAY(SELECT attname::text FROM unnest(conkey) WITH ORDINALITY k(n,pos)
          JOIN pg_attribute a ON a.attrelid=conrelid AND a.attnum=k.n ORDER BY k.pos) AS keys
        FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('p','u','f') ORDER BY conname`,
        [table],
      )
    ).rows,
    keys = constraints.find((constraint) => constraint.contype === "p")!.keys,
    mapping: IndexJob["indexes"] = [];
  await client.query(`CREATE TABLE ${identifier(staging)} (LIKE ${identifier(table)} INCLUDING ALL EXCLUDING INDEXES)`);
  for (const [position, constraint] of constraints.entries()) {
    const staged = `${staging}_c${position}`;
    await client.query(
      `ALTER TABLE ${identifier(staging)} ADD CONSTRAINT ${identifier(staged)} ${constraint.definition}`,
    );
    if (constraint.contype !== "f") mapping.push({ name: constraint.conname, staged });
  }
  const oldIndexes = (
    await client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=$1 ORDER BY indexname",
      [table],
    )
  ).rows;
  for (const index of oldIndexes) {
    if (mapping.some((entry) => entry.name === index.indexname)) continue;
    const staged = `${staging}_i${mapping.length}`;
    await client.query(
      index.indexdef.replace(
        /^CREATE (UNIQUE )?INDEX .*? ON .*? USING /u,
        `CREATE $1INDEX ${identifier(staged)} ON ${identifier(staging)} USING `,
      ),
    );
    mapping.push({ name: index.indexname, staged });
  }
  for (const index of missing) {
    const staged = `${staging}_i${mapping.length}`;
    await client.query(index.sql.replace(indexPattern, `CREATE INDEX ${identifier(staged)} ON ${identifier(staging)}`));
    mapping.push({ name: index.name, staged });
  }
  const upper = (
    await client.query<Record<string, unknown>>(
      `SELECT ${keys.map(identifier).join(",")} FROM ${identifier(table)} ORDER BY ${keys.map((key) => `${identifier(key)} DESC`).join(",")} LIMIT 1`,
    )
  ).rows[0]!;
  const names = columns.map(identifier).join(","),
    identity = keys.map((key) => `${identifier(key)}=OLD.${identifier(key)}`).join(" AND "),
    updates = columns
      .filter((column) => !keys.includes(column))
      .map((column) => `${identifier(column)}=excluded.${identifier(column)}`)
      .join(",");
  await client.query(`CREATE OR REPLACE FUNCTION ${identifier(`${staging}_sync`)}() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF TG_OP<>'INSERT' THEN DELETE FROM ${identifier(staging)} WHERE ${identity}; END IF;
      IF TG_OP<>'DELETE' THEN INSERT INTO ${identifier(staging)} (${names}) OVERRIDING SYSTEM VALUE
        VALUES (${columns.map((column) => `NEW.${identifier(column)}`).join(",")})
        ON CONFLICT (${keys.map(identifier).join(",")}) DO UPDATE SET ${updates}; END IF;
      RETURN NULL;
    END $body$`);
  await client.query(`CREATE TRIGGER ha_pglite_index_mirror AFTER INSERT OR UPDATE OR DELETE ON ${identifier(table)}
    FOR EACH ROW EXECUTE FUNCTION ${identifier(`${staging}_sync`)}()`);
  await client.query(
    `INSERT INTO ha_pglite_index_backfill(table_name,staging,retired,columns,keys,indexes,upper_bound)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT(table_name) DO UPDATE SET staging=excluded.staging,
    retired=excluded.retired,columns=excluded.columns,keys=excluded.keys,indexes=excluded.indexes,upper_bound=excluded.upper_bound,cursor=NULL,complete=false`,
    [table, staging, retired, columns, keys, JSON.stringify(mapping), JSON.stringify(keys.map((key) => upper[key]))],
  );
}

/** One transaction copies at most 64 rows, or publishes one completed table. */
export async function backfillPGliteIndexPage(client: PoolClient): Promise<{ processed: number; done: boolean }> {
  const job = (
    await client.query<IndexJob>(
      "SELECT * FROM ha_pglite_index_backfill WHERE NOT complete ORDER BY table_name LIMIT 1",
    )
  ).rows[0];
  if (!job) return { processed: 0, done: true };
  const names = job.columns.map(identifier).join(","),
    keys = job.keys.map(identifier).join(","),
    after = job.cursor ? `(${keys})>(${job.keys.map((_, index) => `$${index + 1}`).join(",")}) AND ` : "",
    page = await client.query<Record<string, unknown>>(
      `WITH batch AS MATERIALIZED (
      SELECT ${names} FROM ${identifier(job.table_name)} WHERE ${after} (${keys})<=(${job.keys.map((_, index) => `$${(job.cursor?.length ?? 0) + index + 1}`).join(",")}) ORDER BY ${keys} LIMIT 64
    ), copied AS (INSERT INTO ${identifier(job.staging)} (${names}) OVERRIDING SYSTEM VALUE SELECT ${names} FROM batch
      ON CONFLICT (${keys}) DO NOTHING) SELECT ${keys} FROM batch ORDER BY ${keys}`,
      [...(job.cursor ?? []), ...job.upper_bound],
    );
  if (page.rows.length) {
    await client.query("UPDATE ha_pglite_index_backfill SET cursor=$2::jsonb WHERE table_name=$1", [
      job.table_name,
      JSON.stringify(job.keys.map((key) => page.rows.at(-1)![key])),
    ]);
    return { processed: page.rows.length, done: false };
  }
  // Copying explicit identity values does not advance the staging sequence. Its source
  // sequence already tracks foreground inserts; read that scalar rather than scanning MAX.
  const identities = (
    await client.query<{ attname: string }>(
      "SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attidentity<>''",
      [job.table_name],
    )
  ).rows;
  for (const { attname } of identities) {
    const sequence = (
      await client.query<{ name: string }>("SELECT pg_get_serial_sequence($1,$2) AS name", [job.table_name, attname])
    ).rows[0]!.name;
    const value = (
      await client.query<{ last_value: string; is_called: boolean }>(`SELECT last_value,is_called FROM ${sequence}`)
    ).rows[0]!;
    await client.query("SELECT setval(pg_get_serial_sequence($1,$2),$3::bigint,$4)", [
      job.staging,
      attname,
      value.last_value,
      value.is_called,
    ]);
  }
  // Metadata-only publication. Keep the prior tree until the compatibility window closes.
  await client.query(`DROP TRIGGER ha_pglite_index_mirror ON ${identifier(job.table_name)}`);
  for (const [index, row] of job.indexes.entries()) {
    if (
      (
        await client.query(
          "SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND tablename=$1 AND indexname=$2",
          [job.table_name, row.name],
        )
      ).rows.length
    )
      await client.query(`ALTER INDEX ${identifier(row.name)} RENAME TO ${identifier(`${job.retired}_i${index}`)}`);
  }
  await client.query(`ALTER TABLE ${identifier(job.table_name)} RENAME TO ${identifier(job.retired)}`);
  await client.query(`ALTER TABLE ${identifier(job.staging)} RENAME TO ${identifier(job.table_name)}`);
  for (const row of job.indexes)
    await client.query(`ALTER INDEX ${identifier(row.staged)} RENAME TO ${identifier(row.name)}`);
  await client.query("UPDATE ha_pglite_index_backfill SET complete=true WHERE table_name=$1", [job.table_name]);
  // Rebind materialization triggers/RLS to the published relation; no historical index is built here.
  await initializePGliteReadSchema(client);
  return { processed: 0, done: false };
}
