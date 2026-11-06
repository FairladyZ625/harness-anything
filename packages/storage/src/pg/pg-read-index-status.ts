import type { PoolClient } from "pg";

/** Schema metadata, not tenant data. Only the schema owner schedules physical builds. */
export function readIndexBuildDdl(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ha_read_index_build (
      index_name text PRIMARY KEY, table_name text NOT NULL, statement text NOT NULL,
      complete boolean NOT NULL DEFAULT false)`,
    // Only index identifiers/DDL are stored here, never tenant records. Custom read-only
    // roles need the same admission signal as the standard runtime role.
    "GRANT SELECT ON ha_read_index_build TO PUBLIC",
  ];
}

export async function pendingPgPhysicalIndex(
  client: PoolClient,
  tables: readonly string[],
  indexes?: readonly string[],
): Promise<string | undefined> {
  return (
    await client.query<{ index_name: string }>(
      "SELECT index_name FROM ha_read_index_build WHERE table_name=ANY($1::text[]) AND NOT complete AND ($2::text[] IS NULL OR index_name=ANY($2::text[])) ORDER BY index_name LIMIT 1",
      [tables, indexes ?? null],
    )
  ).rows[0]?.index_name;
}

export async function assertPgPhysicalIndexesReady(
  client: PoolClient,
  tables: readonly string[],
  indexes?: readonly string[],
): Promise<void> {
  const index = await pendingPgPhysicalIndex(client, tables, indexes);
  if (index)
    throw Object.assign(new Error(`索引迁移中; progress index=${index}; retry after background migration.`), {
      code: "projection_pending",
    });
}
