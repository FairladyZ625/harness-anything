import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sqliteOccurredAtEpochMsSql, sqliteOccurredAtUtcDaySql } from "../projection/iso-timestamp-sql.ts";

const MS_PER_DAY = 86_400_000;
const MAX_DIRECT_DAY_BRANCHES = 32;

export const SQLITE_OCCURRED_AT_MS_SQL = sqliteOccurredAtEpochMsSql("occurred_at");
export const SQLITE_OCCURRED_AT_DAY_SQL = sqliteOccurredAtUtcDaySql("occurred_at");

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
  readonly boundsPinned?: boolean;
}

export interface SqliteEventWindowResult {
  readonly sourceRevision: number;
  readonly events: readonly CanonicalEventV1[];
  readonly lastScannedRevision: number;
  readonly windowMaxRevision: number;
  readonly done: boolean;
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
    return finalizeSqliteWindowPage(sourceRevision, upperRevision, input.limit, rows);
  }

  // Case A: Exact millisecond window (equal endpoints) — direct seek on (occurred_at_ms, revision).
  if (afterMs !== undefined && beforeMs !== undefined && afterMs === beforeMs) {
    const rows = query(
      `SELECT event_json FROM event WHERE (${SQLITE_OCCURRED_AT_MS_SQL})=? AND revision>? AND revision<=? ` +
        "ORDER BY revision ASC LIMIT ?",
      [afterMs, input.afterRevision, upperRevision, batchLimit],
    );
    return finalizeSqliteWindowPage(sourceRevision, upperRevision, input.limit, rows);
  }

  const startDay = afterMs === undefined ? undefined : Math.floor(afterMs / MS_PER_DAY);
  const endDay = beforeMs === undefined ? undefined : Math.floor(beforeMs / MS_PER_DAY);

  // Case B: Single UTC day (covers 100% of --date YYYY-MM-DD and intra-day windows) — O(limit) seek on (day, revision, ms).
  if (startDay !== undefined && endDay !== undefined && startDay === endDay) {
    const isFullDay = afterMs === startDay * MS_PER_DAY && beforeMs === startDay * MS_PER_DAY + MS_PER_DAY - 1;
    const rows = isFullDay
      ? query(
          `SELECT event_json FROM event WHERE (${SQLITE_OCCURRED_AT_DAY_SQL})=? AND revision>? AND revision<=? ` +
            "ORDER BY revision ASC LIMIT ?",
          [startDay, input.afterRevision, upperRevision, batchLimit],
        )
      : query(
          `SELECT event_json FROM event WHERE (${SQLITE_OCCURRED_AT_DAY_SQL})=? AND revision>? AND revision<=? ` +
            `AND (${SQLITE_OCCURRED_AT_MS_SQL})>=? AND (${SQLITE_OCCURRED_AT_MS_SQL})<=? ` +
            "ORDER BY revision ASC LIMIT ?",
          [startDay, input.afterRevision, upperRevision, afterMs!, beforeMs!, batchLimit],
        );
    return finalizeSqliteWindowPage(sourceRevision, upperRevision, input.limit, rows);
  }

  // Case C: Multi-day bounded window (<= 32 days) — per-day bounded index seeks merged by revision.
  if (startDay !== undefined && endDay !== undefined && endDay - startDay + 1 <= MAX_DIRECT_DAY_BRANCHES) {
    const days = Array.from({ length: endDay - startDay + 1 }, (_, i) => startDay + i);
    const rows = querySqliteMultiDayWindow(
      query,
      days,
      input.afterRevision,
      upperRevision,
      afterMs,
      beforeMs,
      batchLimit,
    );
    return finalizeSqliteWindowPage(sourceRevision, upperRevision, input.limit, rows);
  }

  // Case D: Wide (> 32 days) or open-ended window — loose index skip-scan for active UTC days.
  const activeDays = findSqliteActiveDays(query, startDay, endDay, MAX_DIRECT_DAY_BRANCHES + 1);
  if (activeDays.length === 0) {
    return {
      sourceRevision,
      events: [],
      lastScannedRevision: upperRevision,
      windowMaxRevision: upperRevision,
      done: true,
    };
  }
  if (activeDays.length <= MAX_DIRECT_DAY_BRANCHES) {
    const rows = querySqliteMultiDayWindow(
      query,
      activeDays,
      input.afterRevision,
      upperRevision,
      afterMs,
      beforeMs,
      batchLimit,
    );
    return finalizeSqliteWindowPage(sourceRevision, upperRevision, input.limit, rows);
  }

  // Fallback for genuinely dense >32-day windows: revision-ordered filtered scan.
  const clauses = ["revision>?", "revision<=?"];
  const values: (string | number)[] = [input.afterRevision, upperRevision];
  if (afterMs !== undefined) {
    clauses.push(`(${SQLITE_OCCURRED_AT_MS_SQL})>=?`);
    values.push(afterMs);
  }
  if (beforeMs !== undefined) {
    clauses.push(`(${SQLITE_OCCURRED_AT_MS_SQL})<=?`);
    values.push(beforeMs);
  }
  values.push(batchLimit);
  const rows = query(
    `SELECT event_json FROM event WHERE ${clauses.join(" AND ")} ORDER BY revision ASC LIMIT ?`,
    values,
  );
  return finalizeSqliteWindowPage(sourceRevision, upperRevision, input.limit, rows);
}

function querySqliteMultiDayWindow(
  query: SqliteWindowQueryFn,
  days: readonly number[],
  afterRevision: number,
  upperRevision: number,
  afterMs: number | undefined,
  beforeMs: number | undefined,
  batchLimit: number,
): Record<string, import("node:sqlite").SQLOutputValue>[] {
  const branches: string[] = [];
  const values: (string | number)[] = [];
  const startDay = afterMs === undefined ? undefined : Math.floor(afterMs / MS_PER_DAY);
  const endDay = beforeMs === undefined ? undefined : Math.floor(beforeMs / MS_PER_DAY);
  for (const day of days) {
    const clauses = [`(${SQLITE_OCCURRED_AT_DAY_SQL})=?`, "revision>?", "revision<=?"];
    values.push(day, afterRevision, upperRevision);
    if (afterMs !== undefined && day === startDay && afterMs > day * MS_PER_DAY) {
      clauses.push(`(${SQLITE_OCCURRED_AT_MS_SQL})>=?`);
      values.push(afterMs);
    }
    if (beforeMs !== undefined && day === endDay && beforeMs < day * MS_PER_DAY + MS_PER_DAY - 1) {
      clauses.push(`(${SQLITE_OCCURRED_AT_MS_SQL})<=?`);
      values.push(beforeMs);
    }
    values.push(batchLimit);
    branches.push(
      `SELECT revision FROM (SELECT revision FROM event WHERE ${clauses.join(" AND ")} ORDER BY revision ASC LIMIT ?)`,
    );
  }
  values.push(batchLimit);
  const revRows = query(`SELECT revision FROM (${branches.join(" UNION ALL ")}) ORDER BY revision ASC LIMIT ?`, values);
  if (revRows.length === 0) return [];
  const revisions = revRows.map((row) => Number(row.revision));
  const placeholders = revisions.map(() => "?").join(",");
  return query(`SELECT event_json FROM event WHERE revision IN (${placeholders}) ORDER BY revision ASC`, revisions);
}

function findSqliteActiveDays(
  query: SqliteWindowQueryFn,
  startDay: number | undefined,
  endDay: number | undefined,
  maxDays: number,
): number[] {
  const initClauses: string[] = [`(${SQLITE_OCCURRED_AT_DAY_SQL}) IS NOT NULL`];
  const stepClauses: string[] = [`(${SQLITE_OCCURRED_AT_DAY_SQL})>days.d`];
  const values: (string | number)[] = [];
  if (startDay !== undefined) {
    initClauses.push(`(${SQLITE_OCCURRED_AT_DAY_SQL})>=?`);
    values.push(startDay);
  }
  if (endDay !== undefined) {
    initClauses.push(`(${SQLITE_OCCURRED_AT_DAY_SQL})<=?`);
    values.push(endDay);
    stepClauses.push(`(${SQLITE_OCCURRED_AT_DAY_SQL})<=?`);
    values.push(endDay);
  }
  values.push(maxDays);
  const rows = query(
    `WITH RECURSIVE days(d) AS (` +
      `SELECT MIN(${SQLITE_OCCURRED_AT_DAY_SQL}) FROM event WHERE ${initClauses.join(" AND ")} ` +
      `UNION ALL ` +
      `SELECT (SELECT MIN(${SQLITE_OCCURRED_AT_DAY_SQL}) FROM event WHERE ${stepClauses.join(" AND ")}) ` +
      `FROM days WHERE days.d IS NOT NULL` +
      `) SELECT d FROM days WHERE d IS NOT NULL LIMIT ?`,
    values,
  );
  return rows.map((row) => Number(row.d));
}

function finalizeSqliteWindowPage(
  sourceRevision: number,
  upperRevision: number,
  limit: number,
  rows: readonly Record<string, import("node:sqlite").SQLOutputValue>[],
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
  };
}
