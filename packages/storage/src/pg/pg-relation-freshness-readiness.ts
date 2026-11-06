import type { PoolClient } from "pg";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

/** Endpoint refs whose anchored relations still need their stored freshness recomputed. */
export const PG_RELATION_FRESHNESS_DIRTY_TABLE = "ha_relation_freshness_dirty";

/** Whether every relation of the scope carries freshness stored at the current cut. */
export async function pgRelationFreshnessReady(client: PoolClient, scope: PgProjectionScope): Promise<boolean> {
  const result = await client.query<{ pending: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND freshness IS NULL)
       OR EXISTS (SELECT 1 FROM ${PG_RELATION_FRESHNESS_DIRTY_TABLE} WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3)
       AS pending`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  return !result.rows[0]!.pending;
}
