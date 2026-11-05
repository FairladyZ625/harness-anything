import { backfillPgDecisionSearchPage } from "./pg-decision-search.ts";
import { isPgDecisionReadReady } from "./pg-decision-read-status.ts";
import type { Pool } from "pg";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";

/** Writer queue only. Version/NULL partial indexes are the persisted cursor: no completed row is scanned again. */
export function backfillPgReadIndexPage(pool: Pool, scope: PgProjectionScope, repoId: string) {
  return withPostgresTransaction(
    pool,
    async (client) => {
      const keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
      // Only one bounded transaction per turn. A nonzero page always yields to foreground work.
      for (const [pending, sql, parameters] of [
        [
          `SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND ((model='runtime-session' AND read_index_version<2)
          OR (model IN ('pin','lease-interval','relation-write') AND read_index_version=0)) LIMIT 1`,
          "SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed",
          keys,
        ],
        [
          `SELECT 1 FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4
        AND read_index_version<5 LIMIT 1`,
          "SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed",
          [...keys, repoId],
        ],
        [
          `SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND decision_sort_key IS NULL LIMIT 1`,
          "SELECT ha_backfill_decision_indexes($1,$2,$3) AS processed",
          keys,
        ],
        [
          `SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND model='document' AND document_metadata IS NULL LIMIT 1`,
          "SELECT processed FROM ha_backfill_document_metadata($1,$2,$3)",
          keys,
        ],
      ] as const) {
        // After contraction the old backfill function can be gone. Complete scopes never reference it.
        if (!(await client.query(pending, [...parameters])).rows.length) continue;
        const processed = Number((await client.query<{ processed: number }>(sql, [...parameters])).rows[0]!.processed);
        if (processed) return { processed, done: false };
      }
      if (await isPgDecisionReadReady(client, scope, "search")) return { processed: 0, done: true };
      return backfillPgDecisionSearchPage(client, scope);
    },
    scope,
  );
}
