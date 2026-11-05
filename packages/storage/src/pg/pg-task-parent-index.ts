import type { PoolClient } from "pg";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

/** RLS cannot push non-leakproof JSON extraction into an index condition. Keep the
 * derived parent scalar in the same row; current and previous writers share its trigger.
 */
export function taskParentIndexDdl(): readonly string[] {
  return [
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS parent_task_id text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS parent_index_version smallint NOT NULL DEFAULT 0",
    `CREATE OR REPLACE FUNCTION ha_task_parent_index_fields() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        NEW.parent_task_id := NEW.snapshot #>> '{task,metadata,parentTaskId}';
        NEW.parent_index_version := 1;
        RETURN NEW;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_task_parent_index_fields BEFORE INSERT OR UPDATE OF snapshot,readers
      ON ha_task_snapshots FOR EACH ROW EXECUTE FUNCTION ha_task_parent_index_fields()`,
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_parent ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,parent_task_id,task_id)`,
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_parent_pending ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,task_id) WHERE parent_index_version=0`,
  ];
}

/** The write trigger covers new rows; only pre-expansion rows need management backfill. */
export async function pgTaskParentIndexReady(client: PoolClient, scope: PgProjectionScope): Promise<boolean> {
  const pending = await client.query(
    `SELECT 1 FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      AND parent_index_version=0 LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  return pending.rows.length === 0;
}

export async function assertPgTaskParentIndexReady(client: PoolClient, scope: PgProjectionScope): Promise<void> {
  if (!(await pgTaskParentIndexReady(client, scope)))
    throw Object.assign(new Error("索引迁移中"), { code: "projection_pending" });
}
