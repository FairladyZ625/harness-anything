import type { SQLOutputValue } from "node:sqlite";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  TaskEventStoreError,
  type AuditEventWindowQuery,
  type AuditEventWindowBatch,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { sqliteOccurredAtEpochMsSql } from "../projection/iso-timestamp-sql.ts";
import { auditWindowRevisionKey, collectAuditWindowRevisions } from "./audit-window-revisions.ts";

const MIN_JS_EPOCH_MS = -8_640_000_000_000_000;
const MAX_JS_EPOCH_MS = 8_640_000_000_000_000;

export const SQLITE_OCCURRED_AT_MS_SQL = sqliteOccurredAtEpochMsSql("occurred_at");

type SqliteWindowRows<T> = (sql: string, values: readonly (string | number | null)[]) => T;

export function readSqliteEventWindow(
  databasePath: string,
  sourceRevision: number,
  query: SqliteWindowRows<Record<string, SQLOutputValue>[]>,
  iterate: SqliteWindowRows<Iterable<Record<string, SQLOutputValue>>>,
  input: AuditEventWindowQuery,
): AuditEventWindowBatch {
  const upperRevision = Math.min(sourceRevision, input.maxRevision ?? sourceRevision);
  const afterMs = input.after === undefined ? MIN_JS_EPOCH_MS : Date.parse(input.after);
  const beforeMs = input.before === undefined ? MAX_JS_EPOCH_MS : Date.parse(input.before);
  const batchLimit = input.limit + 1;
  const batch = (
    events: readonly CanonicalEventV1[],
    hasMore = false,
    continuation?: string,
  ): AuditEventWindowBatch => ({
    sourceRevision,
    events,
    windowMaxRevision: upperRevision,
    lastScannedRevision: hasMore ? events.at(-1)!.workspaceRevision : Math.max(input.afterRevision, upperRevision),
    done: !hasMore,
    ...(continuation === undefined ? {} : { continuation }),
  });
  if (input.afterRevision >= upperRevision || !(afterMs <= beforeMs)) return batch([]);
  const parse = (row: Record<string, SQLOutputValue>) => JSON.parse(String(row.event_json)) as CanonicalEventV1;

  if (input.after === undefined && input.before === undefined) {
    const rows = query("SELECT event_json FROM event WHERE revision>? AND revision<=? ORDER BY revision LIMIT ?", [
      input.afterRevision,
      upperRevision,
      batchLimit,
    ]);
    return batch(rows.slice(0, input.limit).map(parse), rows.length > input.limit);
  }

  const cutDigest = String(query("SELECT digest FROM event WHERE revision=?", [upperRevision])[0]?.digest ?? "");
  const key = auditWindowRevisionKey({ scope: [databasePath, cutDigest], afterMs, beforeMs, upperRevision });
  let page = key.read(input.continuation, input.afterRevision, input.limit);
  if (page === null) {
    const collected = collectAuditWindowRevisions(key, input.afterRevision, input.limit);
    try {
      // The covering time index prunes non-matches. The SQLite external sorter
      // orders revision keys once; iterate drains it without buffering the result.
      for (const row of iterate(
        `SELECT revision FROM event WHERE ` +
          `(${SQLITE_OCCURRED_AT_MS_SQL})>=? AND (${SQLITE_OCCURRED_AT_MS_SQL})<=? ` +
          "AND revision>? AND revision<=? ORDER BY +revision",
        [afterMs, beforeMs, input.afterRevision, upperRevision],
      ))
        collected.append(Number(row.revision));
      page = collected.finish();
    } catch (error) {
      collected.abort();
      throw error;
    }
  }
  const { revisions, continuation } = page;
  if (revisions.length === 0) return batch([]);
  const placeholders = revisions.map(() => "?").join(",");
  const rows = query(`SELECT event_json FROM event WHERE revision IN (${placeholders}) ORDER BY revision`, revisions);
  if (rows.length !== revisions.length)
    throw new TaskEventStoreError("invalid_store", "A selected audit-window revision is missing from the ledger");
  return batch(rows.map(parse), continuation !== undefined, continuation);
}
