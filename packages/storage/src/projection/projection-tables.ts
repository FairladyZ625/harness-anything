import type { DatabaseSync } from "node:sqlite";
/** Shared query tables in the center projection and its full physical replica. */
export const TASK_INDEX_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS task_snapshot (
      task_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      status TEXT,
      pinned INTEGER NOT NULL GENERATED ALWAYS AS (
        json_extract(snapshot_json, '$.task.pinned')
      ) STORED,
      package_disposition TEXT NOT NULL GENERATED ALWAYS AS (
        COALESCE(json_extract(snapshot_json, '$.task.packageDisposition'), 'active')
      ) STORED,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS task_snapshot_status_updated ON task_snapshot(status, updated_at DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_updated_task ON task_snapshot(updated_at DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_revision_task ON task_snapshot(workspace_revision, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_agenda_status_pin ON task_snapshot(status, pinned DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_parent
      ON task_snapshot(json_extract(snapshot_json, '$.task.metadata.parentTaskId'));
    CREATE TABLE IF NOT EXISTS task_package (task_id TEXT PRIMARY KEY, package_path TEXT NOT NULL UNIQUE);`;

export const REPOSITORY_READ_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS artifact_entity_state (
      entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, state_json TEXT NOT NULL,
      PRIMARY KEY(entity_kind, entity_id)
    );
    CREATE TABLE IF NOT EXISTS event_summary (
      workspace_revision INTEGER PRIMARY KEY,
      summary_json TEXT NOT NULL,
      witness_json TEXT NOT NULL,
      row_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_installation (
      installation_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_session (
      runtime_session_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_session_task_binding (
      task_id TEXT NOT NULL,
      runtime_session_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      PRIMARY KEY(task_id, runtime_session_id, execution_id)
    );
    CREATE INDEX IF NOT EXISTS runtime_session_task_binding_session
      ON runtime_session_task_binding(runtime_session_id, task_id, execution_id);
    CREATE TABLE IF NOT EXISTS squad_run_projection (
      squad_run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pinned_entities (
      entity_ref TEXT PRIMARY KEY,
      pinned_at TEXT NOT NULL,
      pinned_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lease_interval (
      task_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      acquired_revision INTEGER NOT NULL,
      released_revision INTEGER,
      holder_json TEXT NOT NULL,
      previous_holder_json TEXT,
      lease_expires_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY(task_id, execution_id, acquired_revision)
    );
    CREATE TABLE IF NOT EXISTS event_index (
      op_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL UNIQUE,
      task_id TEXT,
      event_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS event_index_task_id ON event_index (task_id);
    -- The task list derives created_at and completed_at per row from that task's event history. Both
    -- lookups take the first event in revision order, and event_index_task_id has no revision column,
    -- so each one sorts the task's whole history before returning its first row: one long-lived task
    -- makes a single page unbounded. These two carry revision order in the index instead. They are
    -- separate names because CREATE INDEX IF NOT EXISTS never replaces an existing index, so widening
    -- event_index_task_id would be skipped on every cache already built.
    CREATE INDEX IF NOT EXISTS event_index_task_created ON event_index (task_id, workspace_revision);
    -- completed_at takes the first completion event of the task: the same lookup restricted to
    -- completion events, so it does not walk that task's unrelated history.
    CREATE INDEX IF NOT EXISTS event_index_task_completed ON event_index (task_id, workspace_revision)
      WHERE json_extract(event_json, '$.schema') = 'task-event/v1'
        AND json_extract(event_json, '$.type') = 'task_completed';
    CREATE INDEX IF NOT EXISTS event_index_submission_lookup ON event_index (
      task_id,
      json_extract(event_json, '$.payload.execution.executionId'),
      workspace_revision DESC
    ) WHERE
      json_extract(event_json, '$.schema') = 'task-event/v1'
      AND json_extract(event_json, '$.type') = 'execution_submitted';
    CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_lookup ON event_index (
      json_extract(event_json, '$.payload.runtimeSessionId'),
      json_extract(event_json, '$.payload.definitionSnapshotRef'),
      workspace_revision
    ) WHERE
      json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_dispatches ON event_index(workspace_revision)
      WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
        AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_id ON event_index(
      json_extract(event_json, '$.payload.dispatchId')
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1';
    CREATE INDEX IF NOT EXISTS event_index_runtime_resume_source ON event_index(
      json_extract(event_json, '$.payload.resumedFromDispatchId')
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_started ON event_index(
      json_extract(event_json, '$.payload.startedAt'), json_extract(event_json, '$.payload.dispatchId')
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_attempt_group ON event_index(
      json_extract(event_json, '$.payload.attemptGroupId'), workspace_revision
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_task_execution ON event_index(
      json_extract(event_json, '$.payload.taskId'), json_extract(event_json, '$.payload.executionId'), workspace_revision
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_review_decision ON event_index(
      json_extract(event_json, '$.payload.reviewTarget.decisionId'), workspace_revision
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_session ON event_index(
      json_extract(event_json, '$.payload.runtimeSessionId'), workspace_revision
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1';
    CREATE INDEX IF NOT EXISTS event_index_schedule_events ON event_index(workspace_revision)
      WHERE json_extract(event_json, '$.schema') = 'schedule-event/v1';
    CREATE INDEX IF NOT EXISTS event_index_schedule_entity ON event_index (
      json_extract(event_json, '$.entity.id'), workspace_revision
    ) WHERE json_extract(event_json, '$.schema') = 'schedule-event/v1';
    CREATE INDEX IF NOT EXISTS event_index_actor_executor ON event_index (
      json_extract(event_json, '$.actor.executor.id'), workspace_revision
    ) WHERE
      json_extract(event_json, '$.schema') IN ('fact-event/v1','decision-event/v1','task-event/v1');
    `;

export function createProjectionTables(db: DatabaseSync): void {
  db.exec(TASK_INDEX_TABLES_SQL);
  db.exec(REPOSITORY_READ_TABLES_SQL);
}
