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
      // This one catalog owns both scheduling and completion. A pending step
      // always yields after one page, even if a concurrent writer filled it first.
      const sqlPage = (pending: string, sql: string, parameters = keys) => ({
        pending: async () => (await client.query(pending, parameters)).rows.length > 0,
        run: async () => Number((await client.query<{ processed: number }>(sql, parameters)).rows[0]!.processed),
      });
      const indexes = [
        sqlPage(
          `SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND ((model='runtime-session' AND read_index_version<2)
          OR (model IN ('pin','lease-interval','relation-write') AND read_index_version=0)) LIMIT 1`,
          "SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed",
        ),
        sqlPage(
          `SELECT 1 FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND parent_index_version=0 LIMIT 1`,
          "SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed",
        ),
        sqlPage(
          `SELECT 1 FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4
        AND read_index_version<5 LIMIT 1`,
          "SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed",
          [...keys, repoId],
        ),
        sqlPage(
          `SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND decision_sort_key IS NULL LIMIT 1`,
          "SELECT ha_backfill_decision_indexes($1,$2,$3) AS processed",
        ),
        sqlPage(
          `SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND model='document' AND document_metadata IS NULL LIMIT 1`,
          "SELECT processed FROM ha_backfill_document_metadata($1,$2,$3)",
        ),
        {
          pending: async () => !(await isPgDecisionReadReady(client, scope, "search")),
          run: async () => (await backfillPgDecisionSearchPage(client, scope)).processed,
        },
      ];
      for (const index of indexes) {
        // Complete scopes never call their contracted migration functions.
        if (await index.pending()) return { processed: await index.run(), done: false };
      }
      return { processed: 0, done: true };
    },
    scope,
  );
}
