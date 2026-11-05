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
} as const;
const readIndexVersion = "read_index_version";
const fillColumnsSql = `
    UPDATE event_summary SET
      event_type = json_extract(NEW.row_json, '$.type'),
      occurred_at = json_extract(NEW.row_json, '$.occurredAt'),
      actor_person_id = json_extract(NEW.row_json, '$.actor.personId'),
      actor_executor_id = json_extract(NEW.row_json, '$.actor.executorId'),
      ${readIndexVersion} = 1
    WHERE workspace_revision = NEW.workspace_revision;`;
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
  CREATE TRIGGER IF NOT EXISTS event_summary_read_index_insert
  AFTER INSERT ON event_summary
  BEGIN${fillColumnsSql}${insertEntityRefsSql}
  END;
  CREATE TRIGGER IF NOT EXISTS event_summary_read_index_update
  AFTER UPDATE OF row_json ON event_summary
  BEGIN${fillColumnsSql}
    DELETE FROM event_summary_entity_ref WHERE workspace_revision = NEW.workspace_revision;${insertEntityRefsSql}
  END`;

/** Existing caches predate the scalar columns; add them before the shared DDL indexes them. */
export function ensureEventSummaryReadIndexColumns(db: DatabaseSync): void {
  if (queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_summary'").length === 0) return;
  const present = new Set(queryRows(db, "PRAGMA table_info(event_summary)").map(({ name }) => String(name)));
  for (const [column, type] of Object.entries(columns))
    if (!present.has(column)) runSql(db, `ALTER TABLE event_summary ADD COLUMN ${column} ${type}`);
  if (!present.has(readIndexVersion))
    runSql(db, `ALTER TABLE event_summary ADD COLUMN ${readIndexVersion} INTEGER NOT NULL DEFAULT 0`);
}

/** Fill historical rows in bounded batches; the trigger owns the per-row derivation. */
export function backfillEventSummaryReadIndex(
  db: DatabaseSync,
  onProgress?: (progress: { readonly applied: number; readonly total: number }) => void,
): void {
  let applied = 0,
    total = 0;
  // Terminal signal is the pending-row count itself: a batch that does not lower it means the
  // fill trigger is missing or not firing, and continuing would loop forever.
  for (;;) {
    const pending = Number(
      queryRows(db, `SELECT count(*) AS count FROM event_summary WHERE ${readIndexVersion} < 1`)[0]!.count,
    );
    if (pending === 0) return;
    if (total === 0) total = pending;
    const rows = queryRows<{ workspace_revision: number }>(
      db,
      `SELECT workspace_revision FROM event_summary WHERE ${readIndexVersion} < 1 ORDER BY workspace_revision LIMIT 64`,
    );
    if (rows.length === 0) throw new Error("event summary read-index backfill has pending rows but none readable");
    transaction(db, () => {
      for (const row of rows)
        runSql(db, "UPDATE event_summary SET row_json = row_json WHERE workspace_revision = ?", row.workspace_revision);
    });
    const remaining = Number(
      queryRows(db, `SELECT count(*) AS count FROM event_summary WHERE ${readIndexVersion} < 1`)[0]!.count,
    );
    if (remaining >= pending)
      throw new Error("event summary read-index backfill made no progress; fill triggers are missing");
    applied += pending - remaining;
    onProgress?.({ applied, total });
  }
}
