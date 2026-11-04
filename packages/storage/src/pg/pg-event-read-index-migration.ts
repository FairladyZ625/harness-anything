import type { PoolClient } from "pg";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

/** RLS-safe scalar indexes over immutable event bytes; only a disposable parsing copy is JSONB.
 * Previous writers maintain these through the trigger until 2026-11-18.
 */
export function eventReadIndexDdl(): readonly string[] {
  return [
    ...["event_schema", "event_entity_id", "executor_id", "runtime_session_id", "fact_anchor_id"].map(
      (column) => `ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS ${column} text`,
    ),
    "ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS read_index_version smallint NOT NULL DEFAULT 0",
    `CREATE OR REPLACE FUNCTION ha_event_read_index_fields() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE v jsonb;
      BEGIN
        v := ha_read_index_json(NEW.event_json);
        NEW.event_schema := v->>'schema';
        NEW.event_entity_id := v#>>'{entity,id}';
        NEW.executor_id := v#>>'{actor,executor,id}';
        NEW.runtime_session_id := v#>>'{payload,runtimeSessionId}';
        NEW.fact_anchor_id := CASE WHEN NEW.event_type='fact_recorded' THEN v->>'factId'
          WHEN NEW.event_type='entity_migrated' THEN v#>>'{payload,entity,fact,factId}' END;
        NEW.read_index_version := 1;
        RETURN NEW;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_event_read_index_fields BEFORE INSERT OR UPDATE OF event_json ON ha_events
      FOR EACH ROW EXECUTE FUNCTION ha_event_read_index_fields()`,
    `CREATE INDEX IF NOT EXISTS ha_events_read_index_pending ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,revision) WHERE read_index_version=0`,
    `CREATE INDEX IF NOT EXISTS ha_events_schema_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,event_schema,revision)`,
    `CREATE INDEX IF NOT EXISTS ha_events_schema_entity_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,event_schema,event_entity_id,revision)`,
    `CREATE INDEX IF NOT EXISTS ha_events_executor_schema_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,executor_id,event_schema,revision)`,
    `CREATE INDEX IF NOT EXISTS ha_events_session_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,runtime_session_id,revision)`,
    `CREATE INDEX IF NOT EXISTS ha_events_fact_anchor_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,fact_anchor_id,revision) WHERE fact_anchor_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ha_events_type_time_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,event_type,occurred_at,revision)`,
    `CREATE OR REPLACE FUNCTION ha_backfill_event_read_indexes(tenant text,project text,epoch bigint,repo text)
      RETURNS integer LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE processed integer;
      BEGIN
        WITH batch AS (
          SELECT tenant_id,project_id,repo_id,revision FROM ha_events
          WHERE tenant_id=tenant AND project_id=project AND policy_epoch=epoch AND repo_id=repo
            AND read_index_version=0 ORDER BY revision LIMIT 64 FOR UPDATE
        ), filled AS (
          UPDATE ha_events e SET event_json=e.event_json FROM batch b
          WHERE (e.tenant_id,e.project_id,e.repo_id,e.revision)=(b.tenant_id,b.project_id,b.repo_id,b.revision) RETURNING 1
        ) SELECT count(*)::integer INTO processed FROM filled;
        RETURN processed;
      END $function$`,
  ];
}

export async function assertPgEventReadIndexReady(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
): Promise<void> {
  const pending = await client.query(
    `SELECT 1 FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4
      AND read_index_version=0 LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
  );
  if (pending.rows.length)
    throw Object.assign(new Error("Event read-index backfill is pending"), { code: "projection_pending" });
}
