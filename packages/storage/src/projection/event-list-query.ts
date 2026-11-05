import type { DatabaseSync } from "node:sqlite";
import type {
  EventListPage,
  EventListQuery,
  EventListRow,
} from "@harness-anything/kernel/internal/domain/event-list.ts";
import { assertEventSummaryReadIndexReady } from "./event-summary-read-index.ts";
import { queryRows } from "./rebuildable-task-projection-sql.ts";

/** Shared center/replica list query; only descriptor rows cross this read boundary. */
export function readEventList(db: DatabaseSync, query: EventListQuery): EventListPage {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500)
    throw new Error("event list limit must be between 1 and 500");
  // A read-only connection may share a cache that a writer is still expanding; an incomplete
  // index must fail closed instead of returning a page that silently omits unfilled rows.
  assertEventSummaryReadIndexReady(db);
  const where: string[] = [],
    values: (string | number)[] = [];
  const add = (sql: string, ...args: (string | number)[]) => {
    where.push(sql);
    values.push(...args);
  };
  if (query.revisionBound !== undefined) add("event.workspace_revision < ?", query.revisionBound);
  if (query.type !== undefined) add("event.event_type = ?", query.type);
  if (query.after !== undefined) add("event.occurred_at >= ?", query.after);
  if (query.before !== undefined) add("event.occurred_at <= ?", query.before);
  if (query.actor !== undefined)
    add("(event.actor_person_id = ? OR event.actor_executor_id = ?)", query.actor, query.actor);
  // An entity filter drives from the ref index (ref, revision) so the page stops after k matches
  // instead of reading every historical event to test its JSON array.
  if (query.entity !== undefined) add("ref.entity_ref = ?", query.entity);
  const from =
    query.entity === undefined
      ? "event_summary AS event"
      : "event_summary_entity_ref AS ref JOIN event_summary AS event ON event.workspace_revision = ref.workspace_revision";
  const selected = queryRows(
    db,
    `SELECT event.row_json FROM ${from} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY event.workspace_revision DESC LIMIT ?`,
    ...values,
    query.limit + 1,
  ).map((row) => JSON.parse(String(row.row_json)) as EventListRow);
  const rows = selected.slice(0, query.limit),
    hasMore = selected.length > query.limit;
  return { rows, hasMore, nextCursor: hasMore && rows.length ? String(rows.at(-1)!.revision) : null };
}
