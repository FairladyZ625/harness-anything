import { pendingPgPhysicalIndex } from "./pg-read-index-status.ts";
import { POSTGRES_SCOPE_COLUMNS_SQL } from "../postgres/scope-schema.ts";
import type { PoolClient } from "pg";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

/** Additive v5 expansion. Current and previous writers share these materialization triggers.
 * Keep them after the previous-binary window (2026-11-18): current writes still require them.
 * Backfill runs as bounded management transactions; canonical text is never converted to JSONB.
 */
export function readIndexDdl(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ha_runtime_session_tasks (
      ${POSTGRES_SCOPE_COLUMNS_SQL},readers text[] NOT NULL DEFAULT '{}',task_id text NOT NULL,session_id text NOT NULL,
      PRIMARY KEY(tenant_id,project_id,policy_epoch,task_id,session_id))`,
    `CREATE INDEX IF NOT EXISTS ha_runtime_session_tasks_session ON ha_runtime_session_tasks
      (tenant_id,project_id,policy_epoch,session_id,task_id)`,
    "ALTER TABLE ha_projection_values ADD COLUMN IF NOT EXISTS runtime_liveness text",
    "ALTER TABLE ha_projection_values ADD COLUMN IF NOT EXISTS runtime_outcome text",
    "ALTER TABLE ha_projection_values ADD COLUMN IF NOT EXISTS read_index_version smallint NOT NULL DEFAULT 0",
    "ALTER TABLE ha_projection_values ADD COLUMN IF NOT EXISTS order_at text",
    "ALTER TABLE ha_projection_values ADD COLUMN IF NOT EXISTS order_revision bigint",
    "ALTER TABLE ha_projection_values ADD COLUMN IF NOT EXISTS execution_id text",
    "ALTER TABLE ha_projection_values ADD COLUMN IF NOT EXISTS interval_open boolean",
    "ALTER TABLE ha_projection_values ADD COLUMN IF NOT EXISTS fact_edge boolean",
    // Even json getters decode unrelated strings. Tokenize escapes in the disposable copy:
    // preserve valid surrogate pairs and escaped backslashes; repair only NUL/lone surrogates.
    // Canonical text is untouched. Indexed identities already cross PostgreSQL text columns.
    String.raw`CREATE OR REPLACE FUNCTION ha_read_index_json(serialized text) RETURNS jsonb
      LANGUAGE sql IMMUTABLE STRICT AS $function$
        SELECT COALESCE(string_agg(CASE WHEN part[1] ~ $unsafe$^\\u(?:0000|[dD][89a-fA-F][0-9A-Fa-f]{2})$$unsafe$
          THEN $replacement$\ufffd$replacement$ ELSE part[1] END,'' ORDER BY position),'')::jsonb
        FROM regexp_matches(serialized,$tokens$(\\u[dD][89aAbB][0-9A-Fa-f]{2}\\u[dD][c-fC-F][0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|\\.|[^\\]+)$tokens$,'g')
          WITH ORDINALITY AS tokens(part,position)
      $function$`,
    `CREATE OR REPLACE FUNCTION ha_projection_read_index_fields() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE v jsonb;
      BEGIN
        v := ha_read_index_json(NEW.value);
        IF NEW.model='runtime-session' THEN
          NEW.runtime_liveness := v->>'liveness';
          NEW.runtime_outcome := v->>'outcome';
        ELSIF NEW.model='pin' THEN NEW.order_at := v->>'pinnedAt';
        ELSIF NEW.model='lease-interval' THEN
          NEW.order_revision := (v->>'acquiredRevision')::bigint;
          NEW.execution_id := v->>'executionId';
          NEW.interval_open := v->>'releasedRevision' IS NULL;
        ELSIF NEW.model='relation-write' THEN
          NEW.fact_edge := starts_with(v->>'ownerRef','fact/') OR starts_with(v->>'targetRef','fact/');
        END IF;
        NEW.read_index_version := CASE WHEN NEW.model='runtime-session' THEN 3 ELSE 1 END;
        RETURN NEW;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_projection_read_index_fields BEFORE INSERT OR UPDATE OF value,readers
      ON ha_projection_values FOR EACH ROW WHEN (NEW.model IN ('pin','lease-interval','relation-write','runtime-session'))
      EXECUTE FUNCTION ha_projection_read_index_fields()`,
    `CREATE OR REPLACE FUNCTION ha_runtime_session_task_fields() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          DELETE FROM ha_runtime_session_tasks WHERE tenant_id=OLD.tenant_id AND project_id=OLD.project_id
            AND policy_epoch=OLD.policy_epoch AND session_id=OLD.entity_id;
        END IF;
        IF TG_OP <> 'DELETE' THEN
          INSERT INTO ha_runtime_session_tasks(tenant_id,project_id,policy_epoch,readers,task_id,session_id)
          SELECT NEW.tenant_id,NEW.project_id,NEW.policy_epoch,NEW.readers,binding->>'taskId',NEW.entity_id
          FROM jsonb_array_elements(ha_read_index_json(NEW.value)->'taskBindings') binding
          GROUP BY binding->>'taskId';
        END IF;
        RETURN NULL;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_runtime_session_task_fields
      AFTER INSERT OR UPDATE OF value,readers ON ha_projection_values FOR EACH ROW
      WHEN (NEW.model='runtime-session') EXECUTE FUNCTION ha_runtime_session_task_fields()`,
    `CREATE OR REPLACE TRIGGER ha_runtime_session_task_delete
      AFTER DELETE ON ha_projection_values FOR EACH ROW
      WHEN (OLD.model='runtime-session') EXECUTE FUNCTION ha_runtime_session_task_fields()`,
    `CREATE INDEX IF NOT EXISTS ha_projection_read_index_pending ON ha_projection_values
      (tenant_id,project_id,policy_epoch,model,owner_id,entity_id)
      WHERE read_index_version=0 AND model IN ('pin','lease-interval','relation-write','runtime-session')`,
    `CREATE INDEX IF NOT EXISTS ha_projection_read_index_pending_v2 ON ha_projection_values
      (tenant_id,project_id,policy_epoch,model,owner_id,entity_id)
      WHERE (model='runtime-session' AND read_index_version<2)
         OR (model IN ('pin','lease-interval','relation-write') AND read_index_version=0)`,
    `CREATE INDEX IF NOT EXISTS ha_projection_read_index_pending_v3 ON ha_projection_values
      (tenant_id,project_id,policy_epoch,model,owner_id,entity_id)
      WHERE (model='runtime-session' AND read_index_version<3)
         OR (model IN ('pin','lease-interval','relation-write') AND read_index_version=0)`,
    `CREATE INDEX IF NOT EXISTS ha_projection_runtime_unsettled_order ON ha_projection_values
      (tenant_id,project_id,policy_epoch,entity_id,owner_id) WHERE model='runtime-session' AND runtime_outcome IS NULL`,
    `CREATE INDEX IF NOT EXISTS ha_projection_pin_order ON ha_projection_values
      (tenant_id,project_id,policy_epoch,order_at DESC,entity_id) WHERE model='pin'`,
    `CREATE INDEX IF NOT EXISTS ha_projection_interval_order ON ha_projection_values
      (tenant_id,project_id,policy_epoch,owner_id,order_revision) WHERE model='lease-interval'`,
    `CREATE INDEX IF NOT EXISTS ha_projection_interval_open ON ha_projection_values
      (tenant_id,project_id,policy_epoch,owner_id,execution_id,order_revision)
      WHERE model='lease-interval' AND interval_open`,
    `CREATE INDEX IF NOT EXISTS ha_projection_fact_edges ON ha_projection_values
      (tenant_id,project_id,policy_epoch,entity_id,owner_id) WHERE model='relation-write' AND fact_edge`,
    `CREATE OR REPLACE FUNCTION ha_backfill_projection_read_indexes(tenant text,project text,epoch bigint)
      RETURNS integer LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE processed integer;
      BEGIN
        WITH batch AS (
          SELECT tenant_id,project_id,policy_epoch,model,owner_id,entity_id FROM ha_projection_values
          WHERE tenant_id=tenant AND project_id=project AND policy_epoch=epoch
            AND ((model='runtime-session' AND read_index_version<3)
              OR (model IN ('pin','lease-interval','relation-write') AND read_index_version=0))
          ORDER BY model,owner_id,entity_id LIMIT 64 FOR UPDATE
        ), filled AS (
          UPDATE ha_projection_values p SET value=p.value FROM batch b
          WHERE (p.tenant_id,p.project_id,p.policy_epoch,p.model,p.owner_id,p.entity_id)
            = (b.tenant_id,b.project_id,b.policy_epoch,b.model,b.owner_id,b.entity_id) RETURNING 1
        ) SELECT count(*)::integer INTO processed FROM filled;
        IF processed=0 THEN
          WITH batch AS (
            SELECT task_id FROM ha_task_snapshots WHERE tenant_id=tenant AND project_id=project
              AND policy_epoch=epoch AND parent_index_version=0 ORDER BY task_id LIMIT 64 FOR UPDATE
          ), filled AS (
            UPDATE ha_task_snapshots p SET snapshot=p.snapshot FROM batch b
            WHERE p.tenant_id=tenant AND p.project_id=project AND p.policy_epoch=epoch
              AND p.task_id=b.task_id RETURNING 1
          ) SELECT count(*)::integer INTO processed FROM filled;
        END IF;
        RETURN processed;
      END $function$`,
  ];
}

/** Missing derived fields never become a second, history-scanning read path. */
export async function pgProjectionReadProgress(
  client: PoolClient,
  scope: PgProjectionScope,
  model: string,
): Promise<string | null> {
  const runtime = model === "runtime-session";
  const indexes = runtime
    ? [
        "ha_projection_read_index_pending_v3",
        "ha_projection_runtime_unsettled_order",
        "ha_runtime_session_tasks_session",
      ]
    : [
        "ha_projection_read_index_pending",
        ...(model === "pin"
          ? ["ha_projection_pin_order"]
          : model === "lease-interval"
            ? ["ha_projection_interval_order", "ha_projection_interval_open"]
            : ["ha_projection_fact_edges"]),
      ];
  const index = await pendingPgPhysicalIndex(
    client,
    ["ha_projection_values", "ha_runtime_session_tasks", "ha_runtime_unsettled"],
    indexes,
  );
  if (index) return `index=${index}`;
  const pending = await client.query<{ entity_id: string }>(
    `SELECT entity_id FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      AND model=$4 AND read_index_version${runtime ? "<3" : "=0"}
      ORDER BY owner_id,entity_id LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, model],
  );
  return pending.rows.length ? `model=${model}, next=${pending.rows[0]!.entity_id}` : null;
}

export async function pgProjectionReadSource(
  client: PoolClient,
  scope: PgProjectionScope,
  model: string,
): Promise<string> {
  const progress = await pgProjectionReadProgress(client, scope, model);
  if (progress !== null)
    throw Object.assign(new Error(`索引迁移中; progress ${progress}; retry after background backfill.`), {
      code: "projection_pending",
    });
  return "ha_projection_values";
}

export async function pgSessionTaskReadSource(client: PoolClient, scope: PgProjectionScope): Promise<string> {
  await pgProjectionReadSource(client, scope, "runtime-session");
  return "ha_runtime_session_tasks";
}
