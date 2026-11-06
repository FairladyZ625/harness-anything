-- Frozen complete eventReadIndexDdl() from 7c0c6316054275f48ca0c809dc3bb4e385b045f6.
-- Includes the actual previous trigger, backfill function and pending index; no v6 objects.
ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS event_schema text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS event_entity_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS executor_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS runtime_session_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS source_node_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS fact_anchor_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS dispatch_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS dispatch_key text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS definition_snapshot_ref text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS resumed_from_dispatch_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS payload_task_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS payload_execution_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS canonical_task_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS task_execution_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS agent_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS squad_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS attempt_group_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS review_decision_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS dispatch_started_at text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS dispatch_activity_at text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS registers_domain_type text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS task_index_id text COLLATE "C";

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS read_index_version smallint NOT NULL DEFAULT 0;

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS runtime_session_present boolean NOT NULL DEFAULT false;

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS runtime_session_unsettled boolean NOT NULL DEFAULT false;

ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS summary_json text;

CREATE OR REPLACE FUNCTION ha_fleet_event_summary_from_jsonb(v jsonb) RETURNS text
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
      $function$;

CREATE OR REPLACE FUNCTION ha_fleet_event_summary(serialized text) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT AS $function$
        SELECT ha_fleet_event_summary_from_jsonb(ha_read_index_json(serialized))
      $function$;

CREATE OR REPLACE FUNCTION ha_event_read_index_fields() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE v jsonb;
      BEGIN
        v := ha_read_index_json(NEW.event_json);
        NEW.event_schema := v->>'schema';
NEW.event_entity_id := v#>>'{entity,id}';
NEW.executor_id := v#>>'{actor,executor,id}';
NEW.runtime_session_id := v#>>'{payload,runtimeSessionId}';
NEW.source_node_id := v#>>'{source,nodeId}';
NEW.fact_anchor_id := CASE WHEN NEW.event_type='fact_recorded' THEN v->>'factId' WHEN NEW.event_type='entity_migrated' THEN v#>>'{payload,entity,fact,factId}' END;
NEW.dispatch_id := v#>>'{payload,dispatchId}';
NEW.dispatch_key := CASE WHEN NEW.event_type='runtime_dispatch_requested'
    AND v#>>'{payload,role}' IS DISTINCT FROM 'reviewer'
    THEN COALESCE(v#>>'{payload,dispatchKey}',v#>>'{payload,idempotencyKey}') END;
NEW.definition_snapshot_ref := v#>>'{payload,definitionSnapshotRef}';
NEW.resumed_from_dispatch_id := v#>>'{payload,resumedFromDispatchId}';
NEW.payload_task_id := v#>>'{payload,taskId}';
NEW.payload_execution_id := v#>>'{payload,executionId}';
NEW.canonical_task_id := v->>'taskId';
NEW.task_execution_id := v#>>'{payload,execution,executionId}';
NEW.agent_id := v#>>'{payload,agentId}';
NEW.squad_id := v#>>'{payload,squadId}';
NEW.attempt_group_id := v#>>'{payload,attemptGroupId}';
NEW.review_decision_id := v#>>'{payload,reviewTarget,decisionId}';
NEW.dispatch_started_at := v#>>'{payload,startedAt}';
NEW.dispatch_activity_at := COALESCE(v#>>'{payload,startedAt}',v->>'occurredAt');
NEW.registers_domain_type := v#>>'{payload,registersDomainType}';
NEW.task_index_id := CASE v->>'schema'
    WHEN 'task-progress-event/v1' THEN v#>>'{payload,taskId}'
    WHEN 'agent-runtime-event/v1' THEN CASE NEW.event_type
      WHEN 'runtime_session_task_bound' THEN v#>>'{payload,taskId}'
      WHEN 'runtime_session_started' THEN v#>>'{payload,taskBinding,taskId}' END
    WHEN 'migration-import-event/v1' THEN COALESCE(v#>>'{payload,entity,task,taskId}',
      v#>>'{payload,entity,execution,taskId}',v#>>'{payload,entity,fact,taskId}')
    ELSE v->>'taskId' END;
        NEW.runtime_session_present := NEW.event_type='runtime_dispatch_requested' AND EXISTS (
          SELECT 1 FROM ha_projection_values p WHERE p.tenant_id=NEW.tenant_id AND p.project_id=NEW.project_id
          AND p.policy_epoch=NEW.policy_epoch AND p.model='runtime-session' AND p.owner_id=''
          AND p.entity_id=NEW.runtime_session_id COLLATE "default");
        NEW.runtime_session_unsettled := NEW.runtime_session_present AND EXISTS (
          SELECT 1 FROM ha_projection_values p WHERE p.tenant_id=NEW.tenant_id AND p.project_id=NEW.project_id
          AND p.policy_epoch=NEW.policy_epoch AND p.model='runtime-session' AND p.owner_id=''
          AND p.entity_id=NEW.runtime_session_id COLLATE "default" AND p.runtime_outcome IS NULL);
        IF NEW.summary_json IS NULL THEN
          NEW.summary_json := ha_fleet_event_summary_from_jsonb(v);
        END IF;
        NEW.read_index_version := 5;
        RETURN NEW;
      END $function$;

CREATE OR REPLACE TRIGGER ha_event_read_index_fields BEFORE INSERT OR UPDATE OF event_json ON ha_events
      FOR EACH ROW EXECUTE FUNCTION ha_event_read_index_fields();

CREATE INDEX IF NOT EXISTS ha_events_summary_pending ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,revision) WHERE summary_json IS NULL;

CREATE INDEX IF NOT EXISTS ha_events_read_index_pending_v5 ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,revision) WHERE read_index_version<5;

CREATE INDEX IF NOT EXISTS ha_events_schema_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,event_schema,revision);

CREATE INDEX IF NOT EXISTS ha_events_schema_entity_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,event_schema,event_entity_id,revision);

CREATE INDEX IF NOT EXISTS ha_events_executor_schema_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,executor_id,event_schema,revision);

CREATE INDEX IF NOT EXISTS ha_events_session_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,runtime_session_id,revision);

CREATE INDEX IF NOT EXISTS ha_events_fact_anchor_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,fact_anchor_id,revision) WHERE fact_anchor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ha_events_type_time_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,event_type,occurred_at,revision);

CREATE INDEX IF NOT EXISTS ha_events_dispatch_id
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,dispatch_id,revision) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_key
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,dispatch_key,revision) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_session
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,runtime_session_id,revision) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_definition
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,runtime_session_id,definition_snapshot_ref,revision) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_resume
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,resumed_from_dispatch_id,revision) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_tasks
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,payload_task_id,revision) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_execution
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,payload_task_id,payload_execution_id,revision) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_attempt
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,attempt_group_id,revision) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_decision
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,review_decision_id,revision) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_agent_time
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,agent_id,dispatch_activity_at DESC,dispatch_id DESC) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_squad_time
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,squad_id,dispatch_activity_at DESC,dispatch_id DESC) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_agent_session
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,agent_id,runtime_session_id,dispatch_activity_at DESC,dispatch_id DESC) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_squad_session
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,squad_id,runtime_session_id,dispatch_activity_at DESC,dispatch_id DESC) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_page
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,dispatch_started_at,dispatch_id) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_task_effective_time
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,payload_task_id,(COALESCE(dispatch_started_at, occurred_at)) DESC,dispatch_id DESC) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_session_effective_time
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,runtime_session_id,(COALESCE(dispatch_started_at, occurred_at)) DESC,dispatch_id DESC) WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_agent_live_session
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,agent_id,runtime_session_id,dispatch_activity_at DESC,dispatch_id DESC)
      WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested' AND runtime_session_present;

CREATE INDEX IF NOT EXISTS ha_events_dispatch_squad_live_session
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,squad_id,runtime_session_id,dispatch_activity_at DESC,dispatch_id DESC)
      WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested' AND runtime_session_present;

CREATE INDEX IF NOT EXISTS ha_events_projection_dispatch_session ON ha_events
      (tenant_id,project_id,policy_epoch,runtime_session_id) WHERE event_type='runtime_dispatch_requested';

CREATE INDEX IF NOT EXISTS ha_events_dispatch_node_sessions
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,source_node_id,runtime_session_id COLLATE "default")
      WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested' AND runtime_session_present;

CREATE INDEX IF NOT EXISTS ha_events_dispatch_node_unsettled
      ON ha_events (tenant_id,project_id,policy_epoch,repo_id,source_node_id,runtime_session_id COLLATE "default")
      WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested' AND runtime_session_present AND runtime_session_unsettled;

CREATE OR REPLACE FUNCTION ha_dispatch_session_presence() RETURNS trigger
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
      END $function$;

CREATE OR REPLACE TRIGGER ha_dispatch_session_present AFTER INSERT ON ha_projection_values
      FOR EACH ROW WHEN (NEW.model='runtime-session' AND NEW.owner_id='') EXECUTE FUNCTION ha_dispatch_session_presence();

CREATE OR REPLACE TRIGGER ha_dispatch_session_absent AFTER DELETE ON ha_projection_values
      FOR EACH ROW WHEN (OLD.model='runtime-session' AND OLD.owner_id='') EXECUTE FUNCTION ha_dispatch_session_presence();

CREATE OR REPLACE TRIGGER ha_dispatch_session_outcome AFTER UPDATE OF value,readers ON ha_projection_values
      FOR EACH ROW WHEN (NEW.model='runtime-session' AND NEW.owner_id='' AND OLD.runtime_outcome IS DISTINCT FROM NEW.runtime_outcome)
      EXECUTE FUNCTION ha_dispatch_session_presence();

CREATE INDEX IF NOT EXISTS ha_events_dispatch_outcome ON ha_events (tenant_id,project_id,policy_epoch,repo_id,dispatch_id,revision DESC)
      WHERE event_schema='agent-runtime-event/v1' AND event_type='runtime_session_outcome_observed';

CREATE INDEX IF NOT EXISTS ha_events_task_index ON ha_events (tenant_id,project_id,policy_epoch,repo_id,task_index_id,revision DESC) WHERE event_type<>'ci_run_observed';

CREATE INDEX IF NOT EXISTS ha_events_task_submission ON ha_events (tenant_id,project_id,policy_epoch,repo_id,canonical_task_id,task_execution_id,revision DESC)
      WHERE event_schema='task-event/v1' AND event_type='execution_submitted';

CREATE INDEX IF NOT EXISTS ha_events_task_completion ON ha_events (tenant_id,project_id,policy_epoch,repo_id,canonical_task_id,task_execution_id,revision DESC)
      WHERE event_schema='task-event/v1' AND event_type='task_completed';

CREATE INDEX IF NOT EXISTS ha_events_progress ON ha_events (tenant_id,project_id,policy_epoch,repo_id,event_schema,payload_task_id,revision);

CREATE INDEX IF NOT EXISTS ha_events_domain_type ON ha_events (tenant_id,project_id,policy_epoch,repo_id,revision)
      WHERE event_schema='fact-event/v1' AND event_type='fact_recorded' AND registers_domain_type IS NOT NULL;

CREATE OR REPLACE FUNCTION ha_backfill_event_read_indexes(tenant text,project text,epoch bigint,repo text)
      RETURNS integer LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE processed integer;
      BEGIN
        WITH batch AS (
          SELECT tenant_id,project_id,repo_id,revision FROM ha_events
          WHERE tenant_id=tenant AND project_id=project AND policy_epoch=epoch AND repo_id=repo
            AND (read_index_version<5 OR summary_json IS NULL)
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
      END $function$;
