import type { PoolClient } from "pg";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { POSTGRES_SCOPE_COLUMNS_SQL } from "../postgres/scope-schema.ts";

/** A nullable count means an older scope has not completed management backfill. */
export function decisionReadStatusDdl(): readonly string[] {
  const scope = "tenant_id,project_id,policy_epoch",
    added = `SELECT ${scope},(decision_sort_key IS NULL)::integer AS scalar_delta,(NOT search_ready)::integer AS search_delta FROM new_rows`,
    removed = `SELECT ${scope},-(decision_sort_key IS NULL)::integer AS scalar_delta,-(NOT search_ready)::integer AS search_delta FROM old_rows`;
  return [
    `CREATE TABLE IF NOT EXISTS ha_decision_read_status (
      ${POSTGRES_SCOPE_COLUMNS_SQL},readers text[] NOT NULL DEFAULT '{}',
      scalar_pending bigint,search_pending bigint,
      PRIMARY KEY(tenant_id,project_id,policy_epoch))`,
    // Transition tables charge aggregation to this statement's write set. A bulk
    // backfill updates each scope once, instead of leaving one counter version per owner.
    `CREATE OR REPLACE FUNCTION ha_decision_read_status_delta() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE changed record; changes text;
      BEGIN
        changes := CASE TG_OP WHEN 'INSERT' THEN '${added}' WHEN 'DELETE' THEN '${removed}'
          ELSE '${added} UNION ALL ${removed}' END;
        FOR changed IN EXECUTE 'SELECT ${scope},sum(scalar_delta) AS scalar_delta,sum(search_delta) AS search_delta
          FROM (' || changes || ') delta GROUP BY ${scope} HAVING sum(scalar_delta)<>0 OR sum(search_delta)<>0' LOOP
          INSERT INTO ha_decision_read_status(tenant_id,project_id,policy_epoch)
            VALUES(changed.tenant_id,changed.project_id,changed.policy_epoch) ON CONFLICT DO NOTHING;
          UPDATE ha_decision_read_status SET scalar_pending=scalar_pending+changed.scalar_delta,
            search_pending=search_pending+changed.search_delta
          WHERE tenant_id=changed.tenant_id AND project_id=changed.project_id AND policy_epoch=changed.policy_epoch
            AND ((scalar_pending IS NOT NULL AND changed.scalar_delta<>0)
              OR (search_pending IS NOT NULL AND changed.search_delta<>0));
        END LOOP;
        RETURN NULL;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_decision_read_status_insert AFTER INSERT ON ha_decisions
      REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION ha_decision_read_status_delta()`,
    `CREATE OR REPLACE TRIGGER ha_decision_read_status_update AFTER UPDATE ON ha_decisions
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION ha_decision_read_status_delta()`,
    `CREATE OR REPLACE TRIGGER ha_decision_read_status_delete AFTER DELETE ON ha_decisions
      REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION ha_decision_read_status_delta()`,
  ];
}

/** Current writers initialize pristine scopes before their first Decision insert.
 * Existing rows leave both counters unknown; readers require management backfill.
 */
export async function initializePgDecisionReadStatus(client: PoolClient, scope: PgProjectionScope): Promise<void> {
  await client.query(
    `INSERT INTO ha_decision_read_status(tenant_id,project_id,policy_epoch,scalar_pending,search_pending)
    SELECT $1,$2,$3,empty.count,empty.count FROM LATERAL
      (SELECT CASE WHEN EXISTS(SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 LIMIT 1)
        THEN NULL::bigint ELSE 0::bigint END AS count) empty
    WHERE NOT EXISTS(SELECT 1 FROM ha_decision_read_status WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3)
    ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
}

export async function assertPgDecisionReadReady(
  client: PoolClient,
  scope: PgProjectionScope,
  kind: "scalar" | "search",
): Promise<void> {
  const result = await client.query<{ pending: string | null }>(
    `SELECT ${kind === "scalar" ? "scalar_pending" : "search_pending"} AS pending FROM ha_decision_read_status
      WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  if (result.rows[0]?.pending !== "0" && Number(result.rows[0]?.pending ?? NaN) !== 0)
    throw Object.assign(new Error(`Decision ${kind} backfill is pending`), { code: "projection_pending" });
}

/** Management alone may scan the pending index. Hold the summary row only while
 * checking completion, without owner locks: concurrent writer deltas then serialize
 * before or after initialization, without reversing writer/owner lock order.
 */
export async function finishPgDecisionReadBackfill(client: PoolClient, scope: PgProjectionScope): Promise<boolean> {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
  await client.query(
    `INSERT INTO ha_decision_read_status(tenant_id,project_id,policy_epoch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    keys,
  );
  await client.query(
    "SELECT 1 FROM ha_decision_read_status WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 FOR UPDATE",
    keys,
  );
  const result = await client.query<{ scalar_pending: boolean; search_pending: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      AND decision_sort_key IS NULL LIMIT 1) AS scalar_pending,
      EXISTS(SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      AND NOT search_ready LIMIT 1) AS search_pending`,
    keys,
  );
  const row = result.rows[0]!;
  await client.query(
    `UPDATE ha_decision_read_status SET scalar_pending=CASE WHEN $4 THEN scalar_pending ELSE 0 END,
      search_pending=CASE WHEN $5 THEN search_pending ELSE 0 END WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`,
    [...keys, row.scalar_pending, row.search_pending],
  );
  return !row.search_pending;
}
