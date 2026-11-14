import type { Pool, PoolClient } from "pg";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync-types.ts";
import {
  canonicalEventSummary,
  SUMMARY_TEXT_LIMIT,
} from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import {
  storageReadPolicy,
  validateStorageReadWindow,
} from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { POSTGRES_EVENT_REF_INDEX_SCHEMA_STATEMENTS } from "../postgres/event-ledger-schema.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT, postgresScopeRlsStatements } from "../postgres/scope-schema.ts";

const eventReadFields = {
  list_row: `json_build_object('revision',NEW.revision,'opId',NEW.op_id,'eventId',NEW.event_id,
    'schema',v->>'schema','type',NEW.event_type,'occurredAt',NEW.occurred_at,
    'actor',json_build_object('personId',v#>>'{actor,principal,personId}','executorId',v#>>'{actor,executor,id}'),
    'entityRefs',NEW.entity_refs)::text`,
  event_schema: "v->>'schema'",
  event_entity_id: "v#>>'{entity,id}'",
  executor_id: "v#>>'{actor,executor,id}'",
  runtime_session_id: "v#>>'{payload,runtimeSessionId}'",
  source_node_id: "v#>>'{source,nodeId}'",
  fact_anchor_id:
    "CASE WHEN NEW.event_type='fact_recorded' THEN v->>'factId' WHEN NEW.event_type='entity_migrated' THEN v#>>'{payload,entity,fact,factId}' END",
  dispatch_id: "v#>>'{payload,dispatchId}'",
  // The dispatch key moved from payload.idempotencyKey to payload.dispatchKey. Reviewer keys are
  // excluded because their canonical bytes are qualified by the read-time event transform; the
  // projection's runtime-dispatch-key model serves those normalized bytes.
  dispatch_key: `CASE WHEN NEW.event_type='runtime_dispatch_requested'
    AND v#>>'{payload,role}' IS DISTINCT FROM 'reviewer'
    THEN COALESCE(v#>>'{payload,dispatchKey}',v#>>'{payload,idempotencyKey}') END`,
  definition_snapshot_ref: "v#>>'{payload,definitionSnapshotRef}'",
  resumed_from_dispatch_id: "v#>>'{payload,resumedFromDispatchId}'",
  payload_task_id: "v#>>'{payload,taskId}'",
  payload_execution_id: "v#>>'{payload,executionId}'",
  canonical_task_id: "v->>'taskId'",
  task_execution_id: "v#>>'{payload,execution,executionId}'",
  agent_id: "v#>>'{payload,agentId}'",
  squad_id: "v#>>'{payload,squadId}'",
  ["attempt_group_id"]: "v#>>'{payload,attemptGroupId}'",
  review_decision_id: "v#>>'{payload,reviewTarget,decisionId}'",
  dispatch_started_at: "v#>>'{payload,startedAt}'",
  dispatch_activity_at: "COALESCE(v#>>'{payload,startedAt}',v->>'occurredAt')",
  registers_domain_type: "v#>>'{payload,registersDomainType}'",
  task_index_id: `CASE v->>'schema'
    WHEN 'task-progress-event/v1' THEN v#>>'{payload,taskId}'
    WHEN 'agent-runtime-event/v1' THEN CASE NEW.event_type
      WHEN 'runtime_session_task_bound' THEN v#>>'{payload,taskId}'
      WHEN 'runtime_session_started' THEN v#>>'{payload,taskBinding,taskId}' END
    WHEN 'migration-import-event/v1' THEN COALESCE(v#>>'{payload,entity,task,taskId}',
      v#>>'{payload,entity,execution,taskId}',v#>>'{payload,entity,fact,taskId}')
    ELSE v->>'taskId' END`,
};
const eventScope = "tenant_id,project_id,policy_epoch,repo_id";
const dispatchIndexes = [
  ["id", "dispatch_id,revision"],
  ["key", "dispatch_key,revision"],
  ["session", "runtime_session_id,revision"],
  ["definition", "runtime_session_id,definition_snapshot_ref,revision"],
  ["resume", "resumed_from_dispatch_id,revision"],
  ["tasks", "payload_task_id,revision"],
  ["execution", "payload_task_id,payload_execution_id,revision"],
  ["attempt", "attempt_group_id,revision"],
  ["decision", "review_decision_id,revision"],
  ["agent_time", "agent_id,dispatch_activity_at DESC,dispatch_id DESC"],
  ["squad_time", "squad_id,dispatch_activity_at DESC,dispatch_id DESC"],
  ["agent_session", "agent_id,runtime_session_id,dispatch_activity_at DESC,dispatch_id DESC"],
  ["squad_session", "squad_id,runtime_session_id,dispatch_activity_at DESC,dispatch_id DESC"],
  ["page", "dispatch_started_at,dispatch_id"],
  // "Newest dispatch for this task" without walking every dispatch the task ever had:
  // fleet overview reads one current dispatch per lease row. Effective time is
  // `startedAt ?? occurredAt`, matching the dispatch row's timestamp fallback.
  ["task_effective_time", "payload_task_id,(COALESCE(dispatch_started_at, occurred_at)) DESC,dispatch_id DESC"],
  ["session_effective_time", "runtime_session_id,(COALESCE(dispatch_started_at, occurred_at)) DESC,dispatch_id DESC"],
] as const;

/** RLS-safe scalar indexes over immutable event bytes; only a disposable parsing copy is JSONB.
 * Current and previous writers share the trigger; it remains after the 2026-11-18 binary window.
 */
export function eventReadIndexDdl(): readonly string[] {
  return [
    ...POSTGRES_EVENT_REF_INDEX_SCHEMA_STATEMENTS,
    ...postgresScopeRlsStatements("ha_event_entity_refs", { ifNotExists: true }),
    // An old writer may run as soon as the trigger is installed. Prepare its table privileges
    // first, without relying on default grants. Embedded/schema-owner-only databases have no
    // runtime roles; the explicit external grant entrypoint still requires both existing roles.
    ...eventRefIndexGrantDdl(),
    ...Object.keys(eventReadFields).map(
      (column) => `ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS ${column} text COLLATE "C"`,
    ),
    "ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS read_index_version smallint NOT NULL DEFAULT 0",
    "ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS runtime_session_present boolean NOT NULL DEFAULT false",
    "ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS runtime_session_unsettled boolean NOT NULL DEFAULT false",
    "ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS summary_json text",
    "ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS default_summary_json text",
    // Previous writers persist only bounded input; the kernel remains the final summary authority.
    // Even json getters decode unrelated NUL/lone-surrogate escapes. Parse a disposable copy whose
    // strings contain their original JSON escape tokens, then put those tokens back without loss.
    String.raw`CREATE OR REPLACE FUNCTION ha_default_summary_text(encoded jsonb, clip boolean DEFAULT false) RETURNS text
      LANGUAGE plpgsql IMMUTABLE AS $function$
      DECLARE token text; cursor_pos integer := 2; end_pos integer; units integer := 0;
      BEGIN
        IF jsonb_typeof(encoded) IS DISTINCT FROM 'string' THEN RETURN COALESCE(encoded::text,'null'); END IF;
        token := '"'||(encoded #>> '{}')||'"';
        IF NOT clip THEN RETURN token; END IF;
        end_pos := char_length(token);
        WHILE cursor_pos < end_pos AND units < ${SUMMARY_TEXT_LIMIT} LOOP
          cursor_pos := cursor_pos + CASE WHEN substr(token,cursor_pos,1) <> E'\\' THEN 1
            WHEN substr(token,cursor_pos+1,1)='u' THEN 6 ELSE 2 END;
          units := units+1;
        END LOOP;
        RETURN substr(token,1,cursor_pos-1)||'"';
      END $function$`,
    String.raw`CREATE OR REPLACE FUNCTION ha_default_summary_source(serialized text) RETURNS text
      LANGUAGE plpgsql IMMUTABLE STRICT AS $function$
      DECLARE raw jsonb; payload jsonb; claims json;
      BEGIN
        SELECT string_agg(CASE WHEN left(part[1],1)='"'
          THEN to_json(substr(part[1],2,char_length(part[1])-2))::text ELSE part[1] END,'' ORDER BY position)::jsonb
          INTO raw FROM regexp_matches(serialized,$tokens$("(?:\\.|[^"\\])*"|[^"]+)$tokens$,'g')
          WITH ORDINALITY AS tokens(part,position);
        payload := raw->'payload';
        IF jsonb_typeof(payload->'documentClaims')='array' THEN
          SELECT COALESCE(json_agg(json_build_object('path',ha_default_summary_text(claim->'path')::json)),'[]'::json)
          INTO claims FROM jsonb_array_elements(payload->'documentClaims') claim;
        END IF;
        RETURN json_build_object(
          'eventId',ha_default_summary_text(raw->'eventId')::json,
          'schema',ha_default_summary_text(raw->'schema')::json,'type',ha_default_summary_text(raw->'type')::json,
          'occurredAt',ha_default_summary_text(raw->'occurredAt')::json,
          'workspaceRevision',raw->'workspaceRevision',
          'taskId',ha_default_summary_text(raw->'taskId')::json,
          'factId',ha_default_summary_text(raw->'factId')::json,'decisionId',ha_default_summary_text(raw->'decisionId')::json,
          'actor',json_build_object('executor',json_build_object('id',ha_default_summary_text(raw#>'{actor,executor,id}')::json)),
          'payload',json_build_object(
            'taskId',ha_default_summary_text(payload->'taskId')::json,
            'subject',json_build_object('kind',ha_default_summary_text(payload#>'{subject,kind}')::json,
              'taskId',ha_default_summary_text(payload#>'{subject,taskId}')::json),
            'statement',ha_default_summary_text(payload->'statement',true)::json,
            'text',ha_default_summary_text(payload->'text',true)::json,
            'title',ha_default_summary_text(payload->'title',true)::json,
            'runtimeSessionId',ha_default_summary_text(payload->'runtimeSessionId')::json,
            'instanceId',ha_default_summary_text(payload->'instanceId')::json,
            'entityKind',ha_default_summary_text(payload->'entityKind')::json,
            'entityId',ha_default_summary_text(payload->'entityId')::json,
            'witness',CASE WHEN jsonb_typeof(payload->'witness')='object' THEN json_build_object(
              'gateId',ha_default_summary_text(payload#>'{witness,gateId}')::json,
              'result',ha_default_summary_text(payload#>'{witness,result}')::json) END,
            'review',CASE WHEN jsonb_typeof(payload->'review')='object' THEN json_build_object(
              'verdict',ha_default_summary_text(payload#>'{review,verdict}')::json) END,
            'documentClaims',claims
          )
        )::text;
      END $function$`,
    String.raw`CREATE OR REPLACE FUNCTION ha_fleet_event_summary_from_jsonb(v jsonb) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT AS $function$
        SELECT jsonb_build_object(
          'eventId', v->>'eventId', 'schema', v->>'schema', 'type', v->>'type',
          'occurredAt', v->>'occurredAt', 'workspaceRevision', v->'workspaceRevision',
          'taskId', COALESCE(v->>'taskId', v#>>'{payload,taskId}'), 'actor', jsonb_build_object('executor', jsonb_build_object('id', v#>>'{actor,executor,id}')),
          'payload', jsonb_build_object(
            'taskId', COALESCE(v->>'taskId', v#>>'{payload,taskId}'),
            'title', left(v#>>'{payload,title}', 280),
            'statement', left(v#>>'{payload,statement}', 280),
            'text', left(v#>>'{payload,text}', 280)))
      $function$`,
    String.raw`CREATE OR REPLACE FUNCTION ha_fleet_event_summary(serialized text) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT AS $function$
        SELECT ha_fleet_event_summary_from_jsonb(ha_read_index_json(serialized))
      $function$`,
    // Keep the old v5 marker until ref maintenance is installed. A writer between DDL
    // statements must never publish v6 without inserting its entity refs in that transaction.
    `CREATE OR REPLACE FUNCTION ha_event_entity_ref_fields() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF TG_OP='UPDATE' THEN
          DELETE FROM ha_event_entity_refs WHERE tenant_id=OLD.tenant_id AND project_id=OLD.project_id
            AND repo_id=OLD.repo_id AND revision=OLD.revision;
        END IF;
        INSERT INTO ha_event_entity_refs(tenant_id,project_id,policy_epoch,repo_id,readers,entity_ref,revision)
        WITH RECURSIVE suffixes(ref) AS (
          SELECT unnest(NEW.entity_refs)
          UNION
          SELECT substr(ref,strpos(ref,'/')+1) FROM suffixes
          WHERE strpos(ref,'/')>0 AND substr(ref,strpos(ref,'/')+1)<>''
        ) SELECT NEW.tenant_id,NEW.project_id,NEW.policy_epoch,NEW.repo_id,NEW.readers,ref,NEW.revision FROM suffixes
          WHERE NEW.event_type<>'ci_run_observed';
        RETURN NULL;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_event_entity_ref_fields AFTER INSERT OR UPDATE OF event_json,entity_refs,readers ON ha_events
      FOR EACH ROW EXECUTE FUNCTION ha_event_entity_ref_fields()`,
    `CREATE OR REPLACE FUNCTION ha_event_read_index_fields() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE v jsonb;
      BEGIN
        v := ha_read_index_json(NEW.event_json);
        ${Object.entries(eventReadFields)
          .map(([column, expression]) => `NEW.${column} := ${expression};`)
          .join("\n")}
        NEW.runtime_session_present := NEW.event_type='runtime_dispatch_requested' AND EXISTS (
          SELECT 1 FROM ha_projection_values p WHERE p.tenant_id=NEW.tenant_id AND p.project_id=NEW.project_id
          AND p.policy_epoch=NEW.policy_epoch AND p.model='runtime-session' AND p.owner_id=''
          AND p.entity_id=NEW.runtime_session_id COLLATE "default");
        NEW.runtime_session_unsettled := NEW.runtime_session_present AND EXISTS (
          SELECT 1 FROM ha_projection_values p WHERE p.tenant_id=NEW.tenant_id AND p.project_id=NEW.project_id
          AND p.policy_epoch=NEW.policy_epoch AND p.model='runtime-session' AND p.owner_id=''
          AND p.entity_id=NEW.runtime_session_id COLLATE "default" AND p.runtime_outcome IS NULL);
        IF TG_OP='UPDATE' AND OLD.event_json IS DISTINCT FROM NEW.event_json
           AND NEW.default_summary_json IS NOT DISTINCT FROM OLD.default_summary_json THEN
          NEW.default_summary_json := NULL;
        END IF;
        IF NEW.default_summary_json IS NULL THEN
          NEW.default_summary_json := ha_default_summary_source(NEW.event_json);
        END IF;
        IF NEW.summary_json IS NULL THEN
          NEW.summary_json := ha_fleet_event_summary_from_jsonb(v);
        END IF;
        NEW.read_index_version := 6;
        RETURN NEW;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_event_read_index_fields BEFORE INSERT OR UPDATE OF event_json,entity_refs ON ha_events
      FOR EACH ROW EXECUTE FUNCTION ha_event_read_index_fields()`,
    `CREATE INDEX IF NOT EXISTS ha_events_summary_pending ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,revision) WHERE summary_json IS NULL`,
    `CREATE INDEX IF NOT EXISTS ha_events_default_summary_pending ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,revision) WHERE default_summary_json IS NULL`,
    `CREATE INDEX IF NOT EXISTS ha_events_read_index_pending_v5 ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,revision) WHERE read_index_version<5`,
    `CREATE INDEX IF NOT EXISTS ha_events_read_index_pending_v6 ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,revision) WHERE read_index_version<6`,
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
    ...dispatchIndexes.map(
      ([name, columns]) => `CREATE INDEX IF NOT EXISTS ha_events_dispatch_${name}
      ON ha_events (${eventScope},${columns}) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested'`,
    ),
    ...["agent", "squad"].map(
      (member) => `CREATE INDEX IF NOT EXISTS ha_events_dispatch_${member}_live_session
      ON ha_events (${eventScope},${member}_id,runtime_session_id,dispatch_activity_at DESC,dispatch_id DESC)
      WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested' AND runtime_session_present`,
    ),
    // Projection rows retain the existing project scope, so their trigger has no repo_id prefix.
    `CREATE INDEX IF NOT EXISTS ha_events_projection_dispatch_session ON ha_events
      (tenant_id,project_id,policy_epoch,runtime_session_id) WHERE event_type='runtime_dispatch_requested'`,
    ...[false, true].map(
      (unsettled) => `CREATE INDEX IF NOT EXISTS ha_events_dispatch_node_${unsettled ? "unsettled" : "sessions"}
      ON ha_events (${eventScope},source_node_id,runtime_session_id COLLATE "default")
      WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested' AND runtime_session_present${unsettled ? " AND runtime_session_unsettled" : ""}`,
    ),
    `CREATE OR REPLACE FUNCTION ha_dispatch_session_presence() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF TG_OP='DELETE' THEN
          UPDATE ha_events SET runtime_session_present=false,runtime_session_unsettled=false WHERE tenant_id=OLD.tenant_id AND project_id=OLD.project_id
            AND policy_epoch=OLD.policy_epoch AND runtime_session_id=OLD.entity_id COLLATE "C"
            AND event_type='runtime_dispatch_requested' AND runtime_session_present;
        ELSE
          UPDATE ha_events SET runtime_session_present=true,runtime_session_unsettled=(NEW.runtime_outcome IS NULL)
            WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id
            AND policy_epoch=NEW.policy_epoch AND runtime_session_id=NEW.entity_id COLLATE "C"
            AND event_type='runtime_dispatch_requested'
            AND (NOT runtime_session_present OR runtime_session_unsettled IS DISTINCT FROM (NEW.runtime_outcome IS NULL));
        END IF;
        RETURN NULL;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_dispatch_session_present AFTER INSERT ON ha_projection_values
      FOR EACH ROW WHEN (NEW.model='runtime-session' AND NEW.owner_id='') EXECUTE FUNCTION ha_dispatch_session_presence()`,
    `CREATE OR REPLACE TRIGGER ha_dispatch_session_absent AFTER DELETE ON ha_projection_values
      FOR EACH ROW WHEN (OLD.model='runtime-session' AND OLD.owner_id='') EXECUTE FUNCTION ha_dispatch_session_presence()`,
    `CREATE OR REPLACE TRIGGER ha_dispatch_session_outcome AFTER UPDATE OF value,readers ON ha_projection_values
      FOR EACH ROW WHEN (NEW.model='runtime-session' AND NEW.owner_id='' AND OLD.runtime_outcome IS DISTINCT FROM NEW.runtime_outcome)
      EXECUTE FUNCTION ha_dispatch_session_presence()`,
    `CREATE INDEX IF NOT EXISTS ha_events_dispatch_outcome ON ha_events (${eventScope},dispatch_id,revision DESC)
      WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_session_outcome_observed'`,
    `CREATE INDEX IF NOT EXISTS ha_events_task_index ON ha_events (${eventScope},task_index_id,revision DESC) WHERE event_type<>'ci_run_observed'`,
    `CREATE INDEX IF NOT EXISTS ha_events_task_submission ON ha_events (${eventScope},canonical_task_id,task_execution_id,revision DESC)
      WHERE event_schema='task-event/v1' AND event_type='execution_submitted'`,
    `CREATE INDEX IF NOT EXISTS ha_events_task_completion ON ha_events (${eventScope},canonical_task_id,task_execution_id,revision DESC)
      WHERE event_schema='task-event/v1' AND event_type='task_completed'`,
    `CREATE INDEX IF NOT EXISTS ha_events_progress ON ha_events (${eventScope},event_schema,payload_task_id,revision)`,
    `CREATE INDEX IF NOT EXISTS ha_events_domain_type ON ha_events (${eventScope},revision)
      WHERE event_schema='fact-event/v1' AND event_type='fact_recorded' AND registers_domain_type IS NOT NULL`,
    `CREATE OR REPLACE FUNCTION ha_backfill_event_read_indexes(tenant text,project text,epoch bigint,repo text)
      RETURNS integer LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE processed integer;
      BEGIN
        WITH batch AS (
          SELECT tenant_id,project_id,repo_id,revision FROM ha_events
          WHERE tenant_id=tenant AND project_id=project AND policy_epoch=epoch AND repo_id=repo
            AND (read_index_version<6 OR summary_json IS NULL)
          ORDER BY revision LIMIT 64 FOR UPDATE
        ), filled AS (
          UPDATE ha_events e SET event_json=e.event_json, summary_json=ha_fleet_event_summary(e.event_json) FROM batch b
          WHERE (e.tenant_id,e.project_id,e.repo_id,e.revision)=(b.tenant_id,b.project_id,b.repo_id,b.revision) RETURNING 1
        ) SELECT count(*)::integer INTO processed FROM filled;
        IF processed = 0 THEN
          INSERT INTO ha_event_summary_state(tenant_id,project_id,policy_epoch,repo_id,ready)
          VALUES (tenant,project,epoch,repo,true)
          ON CONFLICT (tenant_id,project_id,policy_epoch,repo_id) DO UPDATE SET ready=true;
        END IF;
        RETURN processed;
      END $function$`,
  ];
}

/** Shared by pre-trigger installation and the explicit runtime grant upgrade. */
export function eventRefIndexGrantDdl(): readonly string[] {
  return [POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime, POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.migration].map(
    (role) => `DO $grant$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
        GRANT SELECT,INSERT,DELETE ON ha_event_entity_refs TO "${role}";
      END IF;
    END $grant$`,
  );
}

export async function assertPgEventReadIndexReady(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
  minimumVersion: 5 | 6 = 5,
): Promise<void> {
  const pending = await client.query(
    `SELECT 1 FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4
      AND read_index_version<${minimumVersion} LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
  );
  if (pending.rows.length)
    throw Object.assign(new Error("Event read-index backfill is pending"), { code: "projection_pending" });
}

/** Default event summaries are the serving representation for local/workspace pages. */
export async function pgDefaultEventSummaryGate(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
): Promise<void> {
  const ready = await client.query(
    `SELECT 1 FROM ha_event_summary_state
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND ready
     LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
  );
  if (ready.rowCount) return;
  const pending = await client.query(
    `SELECT 1 FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4
      AND default_summary_json IS NULL LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
  );
  if (pending.rows.length) {
    const error = new Error("Default event summaries are not backfilled");
    Object.defineProperty(error, "code", { value: "projection_pending" });
    throw error;
  }
}

/** Drain historical default summaries in independently committed 64-row transactions. */
export async function backfillPgDefaultEventSummaries(
  pool: Pool,
  scope: PgProjectionScope,
  repoId: string,
): Promise<void> {
  for (;;) {
    const page = await withPostgresTransaction(
      pool,
      (client) => backfillPgDefaultEventSummariesPage(client, scope, repoId),
      scope,
    );
    if (page.done) {
      await withPostgresTransaction(
        pool,
        (client) =>
          client.query(
            `INSERT INTO ha_event_summary_state(tenant_id,project_id,policy_epoch,repo_id,ready)
             VALUES ($1,$2,$3,$4,true)
             ON CONFLICT (tenant_id,project_id,policy_epoch,repo_id) DO UPDATE SET ready=true`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
          ),
        scope,
      );
      return;
    }
  }
}

/** Schema-owner contract step, outside serving PostgreSQL transactions. A scoped page only
 * certifies its own repo; the physical index remains until all scopes have committed readiness.
 * The shared event trigger fills every subsequent old/current writer insert atomically.
 */
export async function contractPgEventSummaryIndex(
  client: PoolClient,
  options: { readonly indexBuild?: "concurrent" | "isolated" } = {},
): Promise<boolean> {
  // A tenant-filtered empty result cannot certify global completion. A schema owner still
  // subject to FORCE RLS safely leaves the index for the deployment's all-scope manager.
  const visibility = await client.query<{ scoped: boolean }>(`SELECT
    row_security_active('ha_events') OR row_security_active('ha_repo_heads') OR
    row_security_active('ha_event_summary_state') AS scoped`);
  if (visibility.rows[0]!.scoped) return false;
  const pending = await client.query(`
    SELECT 1 FROM ha_events WHERE summary_json IS NULL
    UNION ALL
    SELECT 1 FROM ha_repo_heads h WHERE NOT EXISTS (
      SELECT 1 FROM ha_event_summary_state s
      WHERE (s.tenant_id,s.project_id,s.policy_epoch,s.repo_id) =
        (h.tenant_id,h.project_id,h.policy_epoch,h.repo_id) AND s.ready
    ) LIMIT 1`);
  if (pending.rows.length) return false;
  await client.query(
    `DROP INDEX ${options.indexBuild === "isolated" ? "" : "CONCURRENTLY "}IF EXISTS ha_events_summary_pending`,
  );
  return true;
}

/** Bounded 64-row management backfill page for historical default event summaries. */
export async function backfillPgDefaultEventSummariesPage(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
  pageSize: number = storageReadPolicy.defaultValue.pageSizes.sessions,
): Promise<{ readonly processed: number; readonly done: boolean }> {
  if (!validateStorageReadWindow(pageSize, storageReadPolicy.defaultValue.pageSizes.sessions))
    throw new Error("default event summary backfill page size must be between 1 and 64");
  const batch = await client.query<{ readonly revision: string; readonly event_json: string }>(
    `SELECT revision::text AS revision, event_json FROM ha_events
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4
       AND default_summary_json IS NULL
     ORDER BY revision ASC LIMIT $5 FOR UPDATE`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, pageSize],
  );
  if (batch.rows.length === 0) return { processed: 0, done: true };
  const revisions = batch.rows.map((row) => row.revision),
    summaries = batch.rows.map(
      (row) => pgDefaultEventSummaryEntry(JSON.parse(row.event_json) as PersistedCanonicalEventV1).summaryJson,
    );
  await client.query(
    `UPDATE ha_events AS e
     SET default_summary_json = filled.summary_json
     FROM unnest($5::bigint[], $6::text[]) AS filled(revision, summary_json)
     WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.policy_epoch=$3 AND e.repo_id=$4
       AND e.revision=filled.revision`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, revisions, summaries],
  );
  return { processed: batch.rows.length, done: false };
}

export function pgDefaultEventSummaryEntry(
  rawEvent: PersistedCanonicalEventV1,
  sourceRevision?: number,
): {
  readonly revision: number;
  readonly opId: string;
  readonly eventId: string;
  readonly summaryJson: string;
} {
  return {
    revision: sourceRevision ?? rawEvent.workspaceRevision,
    opId: rawEvent.opId,
    eventId: rawEvent.eventId,
    summaryJson: JSON.stringify(canonicalEventSummary(rawEvent)),
  };
}

export async function fillPgDefaultEventSummaries(
  client: PoolClient,
  scope: PgProjectionScope,
  entries: readonly {
    readonly revision: number;
    readonly opId: string;
    readonly eventId: string;
    readonly summaryJson: string;
  }[],
): Promise<void> {
  if (entries.length === 0) return;
  await client.query(
    `UPDATE ha_events AS e
     SET default_summary_json = batch.summary_json
     FROM unnest($4::bigint[], $5::text[], $6::text[], $7::text[])
       AS batch(revision, op_id, event_id, summary_json),
       ha_repo_heads AS h
     WHERE h.tenant_id = $1 AND h.project_id = $2 AND h.policy_epoch = $3
       AND e.tenant_id = h.tenant_id AND e.project_id = h.project_id
       AND e.repo_id = h.repo_id AND e.policy_epoch = $3
       AND e.revision = batch.revision
       AND e.op_id = batch.op_id
       AND e.event_id = batch.event_id
       AND e.default_summary_json IS DISTINCT FROM batch.summary_json`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      entries.map((entry) => entry.revision),
      entries.map((entry) => entry.opId),
      entries.map((entry) => entry.eventId),
      entries.map((entry) => entry.summaryJson),
    ],
  );
}
