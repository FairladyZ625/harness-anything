import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sqliteOccurredAtEpochMsSql } from "../projection/iso-timestamp-sql.ts";

const MIN_JS_EPOCH_MS = -8_640_000_000_000_000;
const MAX_JS_EPOCH_MS = 8_640_000_000_000_000;

export const SQLITE_OCCURRED_AT_MS_SQL = sqliteOccurredAtEpochMsSql("occurred_at");

export type SqliteWindowQueryFn = (
  sql: string,
  values?: readonly (string | number | null)[],
) => Record<string, import("node:sqlite").SQLOutputValue>[];

export interface SqliteEventWindowInput {
  readonly afterRevision: number;
  readonly maxRevision?: number;
  readonly after?: string;
  readonly before?: string;
  readonly limit: number;
  readonly afterOccurredAtMs?: number;
}

export interface SqliteEventWindowResult {
  readonly sourceRevision: number;
  readonly events: readonly CanonicalEventV1[];
  readonly lastScannedRevision: number;
  readonly windowMaxRevision: number;
  readonly done: boolean;
  readonly nextAfterOccurredAtMs?: number;
}

export function readSqliteEventWindow(
  sourceRevision: number,
  query: SqliteWindowQueryFn,
  input: SqliteEventWindowInput,
): SqliteEventWindowResult {
  const upperRevision = input.maxRevision === undefined ? sourceRevision : Math.min(input.maxRevision, sourceRevision);
  if (input.afterRevision >= upperRevision) {
    return {
      sourceRevision,
      events: [],
      lastScannedRevision: input.afterRevision,
      windowMaxRevision: upperRevision,
      done: true,
    };
  }
  const afterMs = input.after === undefined ? undefined : Date.parse(input.after);
  const beforeMs = input.before === undefined ? undefined : Date.parse(input.before);
  const hasTimeWindow = afterMs !== undefined || beforeMs !== undefined;
  if (
    (afterMs !== undefined && Number.isNaN(afterMs)) ||
    (beforeMs !== undefined && Number.isNaN(beforeMs)) ||
    (afterMs !== undefined && beforeMs !== undefined && afterMs > beforeMs)
  ) {
    return {
      sourceRevision,
      events: [],
      lastScannedRevision: upperRevision,
      windowMaxRevision: upperRevision,
      done: true,
    };
  }

  const batchLimit = input.limit + 1;
  if (!hasTimeWindow) {
    const rows = query("SELECT event_json FROM event WHERE revision>? AND revision<=? ORDER BY revision ASC LIMIT ?", [
      input.afterRevision,
      upperRevision,
      batchLimit,
    ]);
    return finalizeSqliteEventRows(sourceRevision, upperRevision, input.limit, rows);
  }

  // Case 1: Exact millisecond window (equal endpoints) — direct covering index seek on (occurred_at_ms, revision).
  if (afterMs !== undefined && beforeMs !== undefined && afterMs === beforeMs) {
    const rows = query(
      `SELECT event_json FROM event WHERE (${SQLITE_OCCURRED_AT_MS_SQL})=? AND revision>? AND revision<=? ` +
        "ORDER BY revision ASC LIMIT ?",
      [afterMs, input.afterRevision, upperRevision, batchLimit],
    );
    return finalizeSqliteEventRows(sourceRevision, upperRevision, input.limit, rows, afterMs);
  }

  const baseLowerMs = afterMs ?? MIN_JS_EPOCH_MS;
  const upperMs = beforeMs ?? MAX_JS_EPOCH_MS;
  const keysetMs =
    input.afterOccurredAtMs !== undefined && input.afterOccurredAtMs >= baseLowerMs
      ? input.afterOccurredAtMs
      : undefined;
  const lowerMs = keysetMs ?? baseLowerMs;
  if (lowerMs > upperMs) {
    return {
      sourceRevision,
      events: [],
      lastScannedRevision: upperRevision,
      windowMaxRevision: upperRevision,
      done: true,
    };
  }

  // Case 2: Covering-index keyset peek on (occurred_at_ms, revision) — O(limit), zero non-matching rows visited.
  const peek = peekSqliteOccurredAtMs(
    query,
    lowerMs,
    upperMs,
    keysetMs,
    input.afterRevision,
    upperRevision,
    batchLimit,
  );
  if (peek.length === 0) {
    return {
      sourceRevision,
      events: [],
      lastScannedRevision: upperRevision,
      windowMaxRevision: upperRevision,
      done: true,
    };
  }
  if (peek.length < batchLimit) {
    const revisions = peek.map((row) => row.revision).sort((a, b) => a - b);
    return fetchSqliteRevisionsPage(sourceRevision, upperRevision, query, revisions, false);
  }

  // Fast exit 2A: contiguous revision prefix from afterRevision + 1 proves no later timestamp can hold a smaller revision.
  let contiguous = true;
  for (let index = 0; index < input.limit; index += 1) {
    if (peek[index]!.revision !== input.afterRevision + 1 + index) {
      contiguous = false;
      break;
    }
  }
  if (contiguous) {
    const selectedRevs = peek.slice(0, input.limit).map((row) => row.revision);
    return fetchSqliteRevisionsPage(
      sourceRevision,
      upperRevision,
      query,
      selectedRevs,
      true,
      peek[input.limit - 1]!.ms,
    );
  }

  // Fast exit 2B: all peeked rows share the final active timestamp in [lowerMs, upperMs], already ordered by revision ASC.
  const firstMs = peek[0]!.ms;
  const lastMs = peek[input.limit]!.ms;
  if (firstMs === lastMs) {
    const later =
      firstMs >= upperMs
        ? []
        : query(
            `SELECT 1 FROM event WHERE (${SQLITE_OCCURRED_AT_MS_SQL})>? AND (${SQLITE_OCCURRED_AT_MS_SQL})<=? ` +
              "AND revision>? AND revision<=? LIMIT 1",
            [firstMs, upperMs, input.afterRevision, upperRevision],
          );
    if (later.length === 0) {
      const selectedRevs = peek.slice(0, input.limit).map((row) => row.revision);
      return fetchSqliteRevisionsPage(sourceRevision, upperRevision, query, selectedRevs, true, firstMs);
    }
  }

  // Case 3: Gapped or non-monotonic window — covering index range scan on [lowerMs, upperMs] only (zero gap rows scanned),
  // sorted by +revision ASC so SQLite never switches to a primary-key scan across non-matching revisions.
  const revRows = query(
    `SELECT revision FROM event WHERE (${SQLITE_OCCURRED_AT_MS_SQL})>=? AND (${SQLITE_OCCURRED_AT_MS_SQL})<=? ` +
      "AND revision>? AND revision<=? ORDER BY +revision ASC LIMIT ?",
    [lowerMs, upperMs, input.afterRevision, upperRevision, batchLimit],
  );
  const hasMore = revRows.length > input.limit;
  const selectedRevs = (hasMore ? revRows.slice(0, input.limit) : revRows).map((row) => Number(row.revision));
  return fetchSqliteRevisionsPage(sourceRevision, upperRevision, query, selectedRevs, hasMore, keysetMs);
}

function peekSqliteOccurredAtMs(
  query: SqliteWindowQueryFn,
  lowerMs: number,
  upperMs: number,
  keysetMs: number | undefined,
  afterRevision: number,
  upperRevision: number,
  batchLimit: number,
): { readonly ms: number; readonly revision: number }[] {
  if (keysetMs !== undefined) {
    const partA = query(
      `SELECT (${SQLITE_OCCURRED_AT_MS_SQL}) AS ms, revision FROM event ` +
        `WHERE (${SQLITE_OCCURRED_AT_MS_SQL})=? AND revision>? AND revision<=? ` +
        "ORDER BY revision ASC LIMIT ?",
      [keysetMs, afterRevision, upperRevision, batchLimit],
    );
    const result = partA.map((row) => ({ ms: Number(row.ms), revision: Number(row.revision) }));
    if (result.length < batchLimit && keysetMs < upperMs) {
      const partB = query(
        `SELECT (${SQLITE_OCCURRED_AT_MS_SQL}) AS ms, revision FROM event ` +
          `WHERE (${SQLITE_OCCURRED_AT_MS_SQL})>? AND (${SQLITE_OCCURRED_AT_MS_SQL})<=? ` +
          "AND revision>? AND revision<=? " +
          `ORDER BY (${SQLITE_OCCURRED_AT_MS_SQL}) ASC, revision ASC LIMIT ?`,
        [keysetMs, upperMs, afterRevision, upperRevision, batchLimit - result.length],
      );
      for (const row of partB) {
        result.push({ ms: Number(row.ms), revision: Number(row.revision) });
      }
    }
    return result;
  }
  const rows = query(
    `SELECT (${SQLITE_OCCURRED_AT_MS_SQL}) AS ms, revision FROM event ` +
      `WHERE (${SQLITE_OCCURRED_AT_MS_SQL})>=? AND (${SQLITE_OCCURRED_AT_MS_SQL})<=? ` +
      "AND revision>? AND revision<=? " +
      `ORDER BY (${SQLITE_OCCURRED_AT_MS_SQL}) ASC, revision ASC LIMIT ?`,
    [lowerMs, upperMs, afterRevision, upperRevision, batchLimit],
  );
  return rows.map((row) => ({ ms: Number(row.ms), revision: Number(row.revision) }));
}

function fetchSqliteRevisionsPage(
  sourceRevision: number,
  upperRevision: number,
  query: SqliteWindowQueryFn,
  revisions: readonly number[],
  hasMore: boolean,
  nextAfterOccurredAtMs?: number,
): SqliteEventWindowResult {
  if (revisions.length === 0) {
    return {
      sourceRevision,
      events: [],
      lastScannedRevision: upperRevision,
      windowMaxRevision: upperRevision,
      done: true,
    };
  }
  const placeholders = revisions.map(() => "?").join(",");
  const rows = query(
    `SELECT event_json FROM event WHERE revision IN (${placeholders}) ORDER BY revision ASC`,
    revisions,
  );
  const events = rows.map((row) => JSON.parse(String(row.event_json)) as CanonicalEventV1);
  const lastScannedRevision = hasMore ? events.at(-1)!.workspaceRevision : upperRevision;
  return {
    sourceRevision,
    events,
    lastScannedRevision,
    windowMaxRevision: upperRevision,
    done: !hasMore,
    ...(hasMore && nextAfterOccurredAtMs !== undefined ? { nextAfterOccurredAtMs } : {}),
  };
}

function finalizeSqliteEventRows(
  sourceRevision: number,
  upperRevision: number,
  limit: number,
  rows: readonly Record<string, import("node:sqlite").SQLOutputValue>[],
  nextAfterOccurredAtMs?: number,
): SqliteEventWindowResult {
  const hasMore = rows.length > limit;
  const events = (hasMore ? rows.slice(0, limit) : rows).map(
    (row) => JSON.parse(String(row.event_json)) as CanonicalEventV1,
  );
  const lastScannedRevision = hasMore ? events.at(-1)!.workspaceRevision : upperRevision;
  return {
    sourceRevision,
    events,
    lastScannedRevision,
    windowMaxRevision: upperRevision,
    done: !hasMore,
    ...(hasMore && nextAfterOccurredAtMs !== undefined ? { nextAfterOccurredAtMs } : {}),
  };
}
