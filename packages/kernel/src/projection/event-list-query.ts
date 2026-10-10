import type { DatabaseSync } from "node:sqlite";
import type { EventListPage, EventListQuery, EventListRow } from "../domain/event-list.ts";
import { queryRows } from "./rebuildable-task-projection-sql.ts";

/** Shared center/replica list query; only descriptor rows cross this read boundary. */
export function readEventList(db: DatabaseSync, query: EventListQuery): EventListPage {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500)
    throw new Error("event list limit must be between 1 and 500");
  const where: string[] = [],
    values: (string | number)[] = [];
  const add = (sql: string, ...args: (string | number)[]) => {
    where.push(sql);
    values.push(...args);
  };
  if (query.revisionBound !== undefined) add("workspace_revision < ?", query.revisionBound);
  if (query.type !== undefined) add("json_extract(row_json, '$.type') = ?", query.type);
  if (query.after !== undefined) add("json_extract(row_json, '$.occurredAt') >= ?", query.after);
  if (query.before !== undefined) add("json_extract(row_json, '$.occurredAt') <= ?", query.before);
  if (query.actor !== undefined)
    add(
      "(CASE WHEN json_extract(row_json, '$.actor.principal.kind')='machine' THEN 'machine:' || json_extract(row_json, '$.actor.principal.nodeId') || ':' || json_extract(row_json, '$.actor.principal.subject') ELSE json_extract(row_json, '$.actor.principal.personId') END = ? OR json_extract(row_json, '$.actor.executorId') = ?)",
      query.actor,
      query.actor,
    );
  if (query.entity !== undefined)
    add(
      "EXISTS (SELECT 1 FROM json_each(row_json, '$.entityRefs') WHERE value = ? OR substr(value, -length(?) - 1) = '/' || ?)",
      query.entity,
      query.entity,
      query.entity,
    );
  const selected = queryRows(
    db,
    `SELECT row_json FROM event_summary ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY workspace_revision DESC LIMIT ?`,
    ...values,
    query.limit + 1,
  ).map((row) => JSON.parse(String(row.row_json)) as EventListRow);
  const rows = selected.slice(0, query.limit),
    hasMore = selected.length > query.limit;
  return { rows, hasMore, nextCursor: hasMore && rows.length ? String(rows.at(-1)!.revision) : null };
}
