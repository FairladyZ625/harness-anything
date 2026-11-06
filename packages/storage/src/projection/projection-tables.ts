import type { DatabaseSync } from "node:sqlite";
import {
  EVENT_SUMMARY_READ_INDEX_TRIGGERS_SQL,
  backfillEventSummaryReadIndex,
  ensureEventSummaryReadIndexColumns,
} from "./event-summary-read-index.ts";
import { ensureRuntimeMemberIndex } from "./runtime-member-index.ts";
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
      row_json TEXT NOT NULL,
      -- Filter columns derived from row_json at write time. SQLite cannot range-probe the JSON
      -- expressions directly, and the event-list reader is shared by every agent/history/doc surface.
      event_type TEXT,
      occurred_at TEXT,
      actor_person_id TEXT,
      actor_executor_id TEXT,
      read_index_version INTEGER NOT NULL DEFAULT 0
    );
    -- One row per expandable entity ref suffix: entity matches a full kind/id ref or a bare id,
    -- and the primary key carries revision order for the DESC page read.
    CREATE TABLE IF NOT EXISTS event_summary_entity_ref (
      workspace_revision INTEGER NOT NULL,
      entity_ref TEXT NOT NULL,
      PRIMARY KEY(entity_ref, workspace_revision)
    ) WITHOUT ROWID;
    -- Re-expanding one revision deletes its rows; without this the delete would scan the ref table.
    CREATE INDEX IF NOT EXISTS event_summary_entity_ref_revision
      ON event_summary_entity_ref(workspace_revision);
    CREATE INDEX IF NOT EXISTS event_summary_type_revision
      ON event_summary(event_type, workspace_revision DESC);
    CREATE INDEX IF NOT EXISTS event_summary_occurred_revision
      ON event_summary(occurred_at, workspace_revision DESC);
    CREATE INDEX IF NOT EXISTS event_summary_actor_person_revision
      ON event_summary(actor_person_id, workspace_revision DESC);
    CREATE INDEX IF NOT EXISTS event_summary_actor_executor_revision
      ON event_summary(actor_executor_id, workspace_revision DESC);
    CREATE INDEX IF NOT EXISTS event_summary_read_index_pending
      ON event_summary(workspace_revision) WHERE read_index_version < 1;
    ${EVENT_SUMMARY_READ_INDEX_TRIGGERS_SQL};
    CREATE TABLE IF NOT EXISTS runtime_installation (
      installation_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_session (
      runtime_session_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL,
      -- Canonical dispatch source for an edge session; '' for center-local or legacy rows. Keeping
      -- it beside the value lets recovery read one node's unsettled sessions without walking the
      -- repository's dispatch history.
      execution_node_id TEXT NOT NULL DEFAULT ''
    );
    -- Startup recovery asks only for unsettled sessions. The trailing session id makes the
    -- filter and ORDER BY one index range instead of a full history scan plus sort.
    CREATE INDEX IF NOT EXISTS runtime_session_unsettled_order
      ON runtime_session(json_extract(value_json, '$.outcome'), runtime_session_id);
    -- A resume names its native provider session; find it without walking settled history.
    CREATE INDEX IF NOT EXISTS runtime_session_provider_session
      ON runtime_session(json_extract(value_json, '$.providerSessionId'), runtime_session_id);
    -- Edge recovery filters by node before outcome, so node-settled history is never visited.
    CREATE INDEX IF NOT EXISTS runtime_session_node_unsettled
      ON runtime_session(execution_node_id, json_extract(value_json, '$.outcome'), runtime_session_id);
    -- Replaced by runtime_session_unsettled_order, which also carries the recovery ORDER BY.
    DROP INDEX IF EXISTS runtime_session_unsettled;
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
      task_active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(task_id, execution_id, acquired_revision)
    );
    CREATE INDEX IF NOT EXISTS lease_interval_current ON lease_interval(task_id, lease_expires_at)
      WHERE released_revision IS NULL;
    CREATE INDEX IF NOT EXISTS lease_interval_active ON lease_interval(task_active, lease_expires_at, task_id)
      WHERE released_revision IS NULL;
    -- Latest-acquisition reads seek one row per task; without this the acquisition order has to
    -- sort every re-entry the task accumulated.
    CREATE INDEX IF NOT EXISTS lease_interval_task_acquisition ON lease_interval(task_id, acquired_revision);
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
    -- Agent reference counts ask "how many dispatches name this agent"; without this index the
    -- count walks every dispatch ever recorded, the same all-history cost as a full read.
    CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_agent ON event_index(
      json_extract(event_json, '$.payload.agentId'), workspace_revision
    ) WHERE
      json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
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
    -- "The current dispatch for this task" is one index seek, not a walk over every dispatch the
    -- task ever had: aggregate reads (fleet overview) only need each task's newest effective
    -- start, startedAt falling back to occurredAt, matching the dispatch row timestamp fallback.
    CREATE INDEX IF NOT EXISTS event_index_runtime_session_started ON event_index(
      json_extract(event_json, '$.payload.runtimeSessionId'),
      COALESCE(json_extract(event_json, '$.payload.startedAt'), json_extract(event_json, '$.occurredAt')) DESC,
      json_extract(event_json, '$.payload.dispatchId') DESC
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_task_started ON event_index(
      json_extract(event_json, '$.payload.taskId'),
      COALESCE(json_extract(event_json, '$.payload.startedAt'), json_extract(event_json, '$.occurredAt')) DESC,
      json_extract(event_json, '$.payload.dispatchId') DESC
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_review_decision ON event_index(
      json_extract(event_json, '$.payload.reviewTarget.decisionId'), workspace_revision
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE INDEX IF NOT EXISTS event_index_runtime_session ON event_index(
      json_extract(event_json, '$.payload.runtimeSessionId'), workspace_revision
    ) WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1';
    -- Recovery now reads its node scope from runtime_session.execution_node_id; this superseded
    -- dispatch-source scan index is removed when an existing projection reopens.
    DROP INDEX IF EXISTS event_index_runtime_dispatch_node;
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

/**
 * Existing projections predate the lease visibility flag; add it before the DDL creates the
 * index that references it. Fresh databases get the column from CREATE TABLE and skip this.
 */
export function ensureLeaseTaskActiveColumn(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lease_interval'").all().length === 0) return;
  const columns = db.prepare("PRAGMA table_info(lease_interval)").all() as { name: string }[];
  if (!columns.some(({ name }) => name === "task_active"))
    db.exec("ALTER TABLE lease_interval ADD COLUMN task_active INTEGER NOT NULL DEFAULT 1");
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_snapshot'").all().length === 0) return;
  db.exec(`UPDATE lease_interval SET task_active = 0 WHERE task_active = 1
    AND NOT EXISTS (SELECT 1 FROM task_snapshot WHERE task_snapshot.task_id = lease_interval.task_id AND status = 'active')`);
}

export function createProjectionTables(db: DatabaseSync): void {
  db.exec(TASK_INDEX_TABLES_SQL);
  ensureEventSummaryReadIndexColumns(db);
  ensureLeaseTaskActiveColumn(db);
  db.exec(REPOSITORY_READ_TABLES_SQL);
  ensureRuntimeMemberIndex(db);
  backfillEventSummaryReadIndex(db);
}
