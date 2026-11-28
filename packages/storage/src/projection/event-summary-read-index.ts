// Additive expansion of event_summary into filterable scalar columns plus an entity-ref
// expansion table. SQLite cannot range-probe a JSON array, so the query path indexes each
// `kind/id` ref and every slash-delimited suffix: `entity` matches a full ref or a bare id.
// Expanded rows are marked by read_index_version; rows written by a previous binary stay at 0
// and are filled here once, so reads never answer from a partially expanded cache.
import type { DatabaseSync } from "node:sqlite";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const columns = {
  event_type: "TEXT",
  occurred_at: "TEXT",
  actor_person_id: "TEXT",
  actor_executor_id: "TEXT",
  source_node_id: "TEXT",
  activity_task_id: "TEXT",
  dispatch_started_at: "TEXT",
} as const;
const readIndexVersion = "read_index_version";
const nodeSourceSql = `CASE json_extract(NEW.witness_json, '$.source')
      WHEN 'local' THEN 'center'
      ELSE CASE
        WHEN json_extract(NEW.witness_json, '$.source.kind') IN ('node', 'assignment')
          THEN json_extract(NEW.witness_json, '$.source.nodeId')
        WHEN substr(json_extract(NEW.witness_json, '$.source'), 1, 16) = 'runtime-session/'
          THEN COALESCE(
            (SELECT NULLIF(execution_node_id, '') FROM runtime_session
             WHERE runtime_session_id = substr(json_extract(NEW.witness_json, '$.source'), 17)),
            (SELECT source_node_id FROM event_index
             WHERE runtime_session_id = substr(json_extract(NEW.witness_json, '$.source'), 17)
               AND event_schema='agent-runtime-event/v1'
               AND event_type='runtime_session_started'
               AND source_node_id IS NOT NULL
               AND workspace_revision < NEW.workspace_revision
             ORDER BY workspace_revision DESC LIMIT 1)
          )
      END END`;
const fillColumnsSql = `
    UPDATE event_summary SET
      event_type = json_extract(NEW.row_json, '$.type'),
      occurred_at = json_extract(NEW.row_json, '$.occurredAt'),
      actor_person_id = json_extract(NEW.row_json, '$.actor.personId'),
      actor_executor_id = json_extract(NEW.row_json, '$.actor.executorId'),
      source_node_id = ${nodeSourceSql},
      activity_task_id = CASE WHEN json_extract(NEW.row_json, '$.schema') IN ('task-event/v1','task-bootstrap-event/v1','task-progress-event/v1')
                                 OR json_extract(NEW.row_json, '$.type') = 'runtime_dispatch_requested'
        THEN COALESCE(json_extract(NEW.summary_json, '$.taskId'), json_extract(NEW.summary_json, '$.payload.taskId')) END,
      dispatch_started_at = CASE WHEN json_extract(NEW.row_json, '$.type') = 'runtime_dispatch_requested'
        THEN COALESCE(json_extract(NEW.row_json, '$.dispatchStartedAt'),
          (SELECT started_at FROM event_index WHERE workspace_revision = NEW.workspace_revision),
          json_extract(NEW.row_json, '$.occurredAt')) END,
      ${readIndexVersion} = 2
    WHERE workspace_revision = NEW.workspace_revision;
    INSERT INTO fleet_node_task(node_id,task_id,revision,person_id,updated_at)
    SELECT source_node_id,activity_task_id,workspace_revision,actor_person_id,occurred_at
    FROM event_summary AS activity
    WHERE workspace_revision=NEW.workspace_revision AND source_node_id IS NOT NULL AND activity_task_id IS NOT NULL
      AND (event_type IN ('task_created','task_bootstrapped','execution_started','execution_submitted','runtime_dispatch_requested')
        OR EXISTS (SELECT 1 FROM fleet_node_task WHERE node_id=activity.source_node_id AND task_id=activity.activity_task_id))
    ON CONFLICT(node_id,task_id) DO UPDATE
      SET revision=excluded.revision,person_id=excluded.person_id,updated_at=excluded.updated_at
      WHERE fleet_node_task.revision < excluded.revision;`;
const insertEntityRefsSql = `
    INSERT INTO event_summary_entity_ref(workspace_revision, entity_ref)
    WITH RECURSIVE suffixes(entity_ref) AS (
      SELECT value FROM json_each(NEW.row_json, '$.entityRefs')
      UNION
      SELECT substr(entity_ref, instr(entity_ref, '/') + 1) FROM suffixes
      WHERE instr(entity_ref, '/') > 0
        AND substr(entity_ref, instr(entity_ref, '/') + 1) <> ''
    )
    SELECT NEW.workspace_revision, entity_ref FROM suffixes;`;
// A fresh revision cannot already own refs, so the insert trigger only fills; the update trigger
// clears this revision's refs through event_summary_entity_ref_revision before re-expanding.
export const EVENT_SUMMARY_READ_INDEX_TRIGGERS_SQL = `
  DROP TRIGGER IF EXISTS event_summary_read_index_insert;
  DROP TRIGGER IF EXISTS event_summary_read_index_update;
  CREATE TRIGGER IF NOT EXISTS event_summary_read_index_insert_v2
  AFTER INSERT ON event_summary
  BEGIN${fillColumnsSql}${insertEntityRefsSql}
  END;
  CREATE TRIGGER IF NOT EXISTS event_summary_read_index_update_v2
  AFTER UPDATE OF row_json ON event_summary
  BEGIN${fillColumnsSql}
    DELETE FROM event_summary_entity_ref WHERE workspace_revision = NEW.workspace_revision;${insertEntityRefsSql}
  END`;

export const FLEET_NODE_TASK_SEED_TYPES: ReadonlySet<string> = new Set([
  "task_created",
  "task_bootstrapped",
  "execution_started",
  "execution_submitted",
  "runtime_dispatch_requested",
]);

/** Expand each `kind/id` ref and every non-empty slash-delimited suffix, matching the recursive CTE trigger. */
export function expandEntityRefSuffixes(entityRefs: readonly string[]): readonly string[] {
  const expanded = new Set<string>();
  for (const raw of entityRefs) {
    let current = raw;
    for (;;) {
      if (expanded.has(current)) break;
      expanded.add(current);
      const slash = current.indexOf("/");
      if (slash === -1) break;
      const next = current.slice(slash + 1);
      if (next.length === 0) break;
      current = next;
    }
  }
  return [...expanded];
}

/** JS twin of `nodeSourceSql` used during trigger-free bulk rebuilds so derived columns match 100%. */
export function deriveEventSummarySourceNodeId(
  source: unknown,
  lookupRuntimeSessionNode: (runtimeSessionId: string) => string | null,
): string | null {
  if (source === "local") return "center";
  if (typeof source === "object" && source !== null) {
    const record = source as { readonly kind?: unknown; readonly nodeId?: unknown };
    if (record.kind === "node" || record.kind === "assignment")
      return typeof record.nodeId === "string" ? record.nodeId : null;
    return null;
  }
  if (typeof source === "string" && source.startsWith("runtime-session/"))
    return lookupRuntimeSessionNode(source.slice(16));
  return null;
}

/** Existing caches predate the scalar columns; add them before the shared DDL indexes them. */
export function ensureEventSummaryReadIndexColumns(db: DatabaseSync): void {
  if (queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_summary'").length === 0) return;
  const present = new Set(queryRows(db, "PRAGMA table_info(event_summary)").map(({ name }) => String(name)));
  for (const [column, type] of Object.entries(columns))
    if (!present.has(column)) runSql(db, `ALTER TABLE event_summary ADD COLUMN ${column} ${type}`);
  if (!present.has(readIndexVersion))
    runSql(db, `ALTER TABLE event_summary ADD COLUMN ${readIndexVersion} INTEGER NOT NULL DEFAULT 0`);
}

// Schema objects are created once per cache generation and never dropped while this connection is
// open, so the sqlite_master lookup is cached per connection. Pending rows are still probed every
// read: a concurrent writer backfilling an older cache must fail closed, not return a partial page.
const schemaReady = new WeakSet<DatabaseSync>();
/** Readers must not answer from a cache whose derived columns or ref rows are still incomplete. */
export function assertEventSummaryReadIndexReady(db: DatabaseSync): void {
  if (!schemaReady.has(db)) {
    const expanded =
      queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='index' AND name='event_summary_read_index_pending_v2'")
        .length > 0;
    if (!expanded) throw pendingReadIndex();
    schemaReady.add(db);
  }
  if (queryRows(db, `SELECT 1 FROM event_summary WHERE ${readIndexVersion} < 2 LIMIT 1`).length > 0)
    throw pendingReadIndex();
}
const pendingReadIndex = () =>
  Object.assign(new Error("Event summary read-index backfill is pending; retry after migration."), {
    code: "projection_pending",
  });

/** Fill historical rows in bounded batches; the trigger owns the per-row derivation. */
export function backfillEventSummaryReadIndex(
  db: DatabaseSync,
  onProgress?: (progress: { readonly applied: number; readonly total: number }) => void,
): void {
  let applied = 0;
  // One pending scan supplies the progress total; batches are selected through the same partial
  // index, so the migration stays linear instead of re-counting all remaining rows per batch.
  const total = Number(
    queryRows(db, `SELECT count(*) AS count FROM event_summary WHERE ${readIndexVersion} < 2`)[0]!.count,
  );
  if (total === 0) return;
  for (;;) {
    const rows = queryRows<{ workspace_revision: number }>(
      db,
      `SELECT workspace_revision FROM event_summary WHERE ${readIndexVersion} < 2 ORDER BY workspace_revision LIMIT 64`,
    );
    if (rows.length === 0) return;
    transaction(db, () => {
      for (const row of rows)
        runSql(db, "UPDATE event_summary SET row_json = row_json WHERE workspace_revision = ?", row.workspace_revision);
    });
    // One point read proves this batch moved. A missing or non-firing trigger would leave the
    // first pending row below v2; without this the loop would re-select it forever.
    const advanced = queryRows<{ read_index_version: number }>(
      db,
      "SELECT read_index_version FROM event_summary WHERE workspace_revision = ?",
      rows[0]!.workspace_revision,
    )[0];
    if (advanced === undefined || Number(advanced.read_index_version) < 2)
      throw new Error("event summary read-index backfill made no progress; fill triggers are missing");
    applied += rows.length;
    onProgress?.({ applied, total });
  }
}

// Select person, node and time from the same latest attributed event. Its node may be null.
const TASK_ATTRIBUTION_COLUMNS_SQL = `
 (SELECT source_node_id FROM event_summary
   WHERE activity_task_id=task_snapshot.task_id AND event_type IN ('task_created','task_bootstrapped')
   ORDER BY workspace_revision LIMIT 1) AS origin_node_id,
 (SELECT occurred_at FROM event_summary
   WHERE activity_task_id=task_snapshot.task_id AND event_type IN ('task_created','task_bootstrapped')
   ORDER BY workspace_revision LIMIT 1) AS origin_at,
 (SELECT source_node_id FROM event_summary
   WHERE activity_task_id=task_snapshot.task_id AND actor_person_id IS NOT NULL
   ORDER BY workspace_revision DESC LIMIT 1) AS latest_node_id,
 (SELECT actor_person_id FROM event_summary WHERE activity_task_id=task_snapshot.task_id AND actor_person_id IS NOT NULL
   ORDER BY workspace_revision DESC LIMIT 1) AS latest_person_id,
 (SELECT occurred_at FROM event_summary WHERE activity_task_id=task_snapshot.task_id AND actor_person_id IS NOT NULL
   ORDER BY workspace_revision DESC LIMIT 1) AS latest_at`;

type TaskAttributionRow = {
  readonly task_id: string;
  readonly origin_node_id: string | null;
  readonly latest_node_id: string | null;
  readonly latest_person_id: string | null;
  readonly latest_at: string | null;
  readonly origin_at: string | null;
};

/** Resolve the selected page in one statement, independently of the task index's wire and plan. */
export function taskAttributionRows(
  db: DatabaseSync,
  taskIds: readonly string[],
): ReadonlyMap<string, TaskAttributionRow> {
  return new Map(
    queryRows<TaskAttributionRow>(
      db,
      `WITH task_snapshot(task_id) AS (SELECT value FROM json_each(?))
     SELECT task_id,${TASK_ATTRIBUTION_COLUMNS_SQL} FROM task_snapshot`,
      JSON.stringify(taskIds),
    ).map((row) => [row.task_id, row]),
  );
}
