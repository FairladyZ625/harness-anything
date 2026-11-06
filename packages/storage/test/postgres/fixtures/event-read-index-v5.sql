-- Frozen from 7c0c6316054275f48ca0c809dc3bb4e385b045f6 eventReadIndexDdl().
-- Previous writer trigger: no entity-ref index table or descriptor column.
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
