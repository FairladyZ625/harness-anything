import type { Pool } from "pg";
import type { PgProjectionScope } from "../../src/pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";

/** Archived selector SQL from 025c30b698, pg-event-queries / pg-projection-values.
 * This is a selector-only lower bound, not an execution of an old application binary.
 * JSON decoding/filtering is deliberately excluded; complete old-adapter red runs are separate.
 */
export async function measureLegacySelector(
  pool: Pool,
  scope: PgProjectionScope,
  backend: string,
  method: string,
  text: string,
  values: unknown[],
  baselineRevision = "025c30b698b9896240c76a525d565afbea130114",
): Promise<void> {
  await withPostgresTransaction(
    pool,
    async (client) => {
      const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values)).rows[0]![
        "QUERY PLAN"
      ];
      const started = performance.now(),
        result = await client.query(text, values),
        elapsedMs = performance.now() - started;
      process.stdout.write(
        `PG_LEGACY_SELECTOR ${backend} ${JSON.stringify({ baselineRevision, method, phase: "warm-selector-only", elapsedMs, returnedRows: result.rows.length, sql: text, plan })}\n`,
      );
    },
    scope,
    { isolationLevel: "repeatable read" },
  );
}
export const legacyEventSql = (
  predicate: string,
  limit = "",
) => `SELECT revision::text, op_id, event_json FROM ha_events
 WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND policy_epoch=$4 AND event_type<>'ci_run_observed'
 AND (cardinality($5::text[])=0 OR readers && $5::text[]) AND revision <= (SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1') AND ${predicate} ORDER BY ha_events.revision ASC ${limit}`;
export const legacyValueSql = (
  owner = false,
) => `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model=$4
 AND (cardinality($5::text[])=0 OR readers && $5::text[])${owner ? " AND owner_id=$6" : ""} ORDER BY entity_id,owner_id`;
