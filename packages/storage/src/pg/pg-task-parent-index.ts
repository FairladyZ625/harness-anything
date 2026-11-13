import type { PoolClient } from "pg";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

/** RLS cannot push non-leakproof JSON extraction into an index condition. Keep the
 * derived parent scalar in the same row; current and previous writers share its trigger.
 */
export function taskParentIndexDdl(): readonly string[] {
  return [
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS parent_task_id text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_status text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_title text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_pinned boolean",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_class text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_superseded_by text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_work_kind text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_risk_tier text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_urgency text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_slug text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_package_disposition text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_lease_phase text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS parent_index_version smallint NOT NULL DEFAULT 0",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS task_index_version smallint NOT NULL DEFAULT 0",
    `CREATE OR REPLACE FUNCTION ha_task_parent_index_fields() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        NEW.parent_task_id := NEW.snapshot #>> '{task,metadata,parentTaskId}';
        NEW.task_status := NEW.snapshot #>> '{task,status}';
        NEW.task_title := NEW.snapshot #>> '{task,title}';
        NEW.task_pinned := COALESCE((NEW.snapshot #>> '{task,pinned}')::boolean, false);
        NEW.task_class := NEW.snapshot #>> '{task,taskClass}';
        NEW.task_superseded_by := NEW.snapshot #>> '{task,supersededBy}';
        NEW.task_work_kind := NEW.snapshot #>> '{task,metadata,workKind}';
        NEW.task_risk_tier := NEW.snapshot #>> '{task,metadata,riskTier}';
        NEW.task_urgency := NEW.snapshot #>> '{task,metadata,urgency}';
        NEW.task_slug := NEW.snapshot #>> '{task,metadata,slug}';
        NEW.task_package_disposition := COALESCE(NEW.snapshot #>> '{task,packageDisposition}', 'active');
        NEW.task_lease_phase := NEW.raw_lease->>'phase';
        NEW.parent_index_version := 1;
        NEW.task_index_version := 2;
        RETURN NEW;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_task_parent_index_fields BEFORE INSERT OR UPDATE OF snapshot,readers,raw_lease
      ON ha_task_snapshots FOR EACH ROW EXECUTE FUNCTION ha_task_parent_index_fields()`,
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_parent ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,parent_task_id,task_id)`,
    // Keep the seek key narrow.  The task payload stays in the heap/TOAST row;
    // putting title or package text in INCLUDE would turn a legal task into an
    // index-tuple-size failure.
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_task_index_v2 ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,task_id)`,
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_active_task_index_v2 ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,task_id)
      WHERE task_package_disposition='active'`,
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_parent_pending_v2 ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,task_id) WHERE parent_index_version=0 OR task_index_version<2`,
    "DROP INDEX IF EXISTS ha_task_snapshots_parent_pending",
    "DROP INDEX IF EXISTS ha_task_snapshots_task_index",
    "DROP INDEX IF EXISTS ha_task_snapshots_active_task_index",
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_active_pinned ON ha_task_snapshots (tenant_id,project_id,policy_epoch,task_pinned DESC,task_id) WHERE task_package_disposition='active'",
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_open_task ON ha_task_snapshots (tenant_id,project_id,policy_epoch,task_id) WHERE task_status NOT IN ('done','cancelled')",
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_pinned_task ON ha_task_snapshots (tenant_id,project_id,policy_epoch,task_pinned DESC,task_id)",
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_lease_phase ON ha_task_snapshots (tenant_id,project_id,policy_epoch,task_lease_phase,task_id) WHERE task_lease_phase IS NOT NULL AND task_lease_phase <> 'released'",
  ];
}

/** The write trigger covers new rows; only pre-expansion rows need management backfill. */
async function taskParentIndexReadyOrThrow(client: PoolClient, scope: PgProjectionScope): Promise<void> {
  const pending = await client.query(
    `SELECT 1 FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      AND (parent_index_version=0 OR task_index_version<2) LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  if (pending.rows.length)
    throw Object.assign(new Error("Task parent-index backfill is pending"), { code: "projection_pending" });
}

export async function assertPgTaskParentIndexReady(client: PoolClient, scope: PgProjectionScope): Promise<void> {
  return taskParentIndexReadyOrThrow(client, scope);
}
