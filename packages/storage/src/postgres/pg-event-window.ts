import type { PoolClient } from "pg";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { validateStorageReadWindow } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { PostgresEventStoreScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";

const MS_PER_DAY = 86_400_000;
const MAX_DIRECT_DAY_BRANCHES = 32;

export interface PgReadEventWindowPayload {
  readonly repoId: string;
  readonly query: {
    readonly afterRevision: number;
    readonly maxRevision?: number;
    readonly after?: string;
    readonly before?: string;
    readonly limit: number;
    readonly boundsPinned?: boolean;
  };
}

export interface PgReadEventWindowResult {
  readonly sourceRevision: number;
  readonly events: readonly CanonicalEventV1[];
  readonly lastScannedRevision: number;
  readonly windowMaxRevision: number;
  readonly done: boolean;
}

export async function readPgEventWindow(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  input: PgReadEventWindowPayload,
  sourceRevision: number,
): Promise<PgReadEventWindowResult> {
  const query = input.query;
  if (!validateStorageReadWindow(query.limit, undefined, query.afterRevision))
    throw new TaskEventStoreError("invalid_store", "event window cursor or size is invalid");
  const upperRevision = query.maxRevision === undefined ? sourceRevision : Math.min(query.maxRevision, sourceRevision);
  if (query.afterRevision >= upperRevision) {
    return {
      sourceRevision,
      events: [],
      lastScannedRevision: query.afterRevision,
      windowMaxRevision: upperRevision,
      done: true,
    };
  }
  const afterMs = query.after === undefined ? undefined : Date.parse(query.after);
  const beforeMs = query.before === undefined ? undefined : Date.parse(query.before);
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

  const batchLimit = query.limit + 1;
  if (!hasTimeWindow) {
    const result = await client.query<{ readonly event_json: string }>(
      "SELECT event_json FROM ha_events " +
        "WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND revision>$4 AND revision<=$5 " +
        "ORDER BY revision ASC LIMIT $6",
      [scope.tenantId, scope.projectId, input.repoId, query.afterRevision, upperRevision, batchLimit],
    );
    return finalizePgWindowPage(sourceRevision, upperRevision, query.limit, result.rows);
  }

  // Case A: Exact millisecond window (equal endpoints) — direct RLS-safe index seek on (occurred_at_ms, revision).
  if (afterMs !== undefined && beforeMs !== undefined && afterMs === beforeMs) {
    const result = await client.query<{ readonly event_json: string }>(
      "SELECT event_json FROM ha_events " +
        "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
        "AND occurred_at_ms=$5 AND revision>$6 AND revision<=$7 " +
        "ORDER BY revision ASC LIMIT $8",
      [
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        input.repoId,
        afterMs,
        query.afterRevision,
        upperRevision,
        batchLimit,
      ],
    );
    return finalizePgWindowPage(sourceRevision, upperRevision, query.limit, result.rows);
  }

  const startDay = afterMs === undefined ? undefined : Math.floor(afterMs / MS_PER_DAY);
  const endDay = beforeMs === undefined ? undefined : Math.floor(beforeMs / MS_PER_DAY);

  // Case B: Single UTC day (100% of --date YYYY-MM-DD and intra-day windows) — O(limit) index seek on (occurred_at_utc_day, revision, occurred_at_ms).
  if (startDay !== undefined && endDay !== undefined && startDay === endDay) {
    const isFullDay = afterMs === startDay * MS_PER_DAY && beforeMs === startDay * MS_PER_DAY + MS_PER_DAY - 1;
    const result = isFullDay
      ? await client.query<{ readonly event_json: string }>(
          "SELECT event_json FROM ha_events " +
            "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
            "AND occurred_at_utc_day=$5 AND revision>$6 AND revision<=$7 " +
            "ORDER BY revision ASC LIMIT $8",
          [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            input.repoId,
            startDay,
            query.afterRevision,
            upperRevision,
            batchLimit,
          ],
        )
      : await client.query<{ readonly event_json: string }>(
          "SELECT event_json FROM ha_events " +
            "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
            "AND occurred_at_utc_day=$5 AND revision>$6 AND revision<=$7 " +
            "AND occurred_at_ms>=$8 AND occurred_at_ms<=$9 " +
            "ORDER BY revision ASC LIMIT $10",
          [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            input.repoId,
            startDay,
            query.afterRevision,
            upperRevision,
            afterMs!,
            beforeMs!,
            batchLimit,
          ],
        );
    return finalizePgWindowPage(sourceRevision, upperRevision, query.limit, result.rows);
  }

  // Case C: Multi-day bounded window (<= 32 days) — per-day bounded index seeks merged by revision.
  if (startDay !== undefined && endDay !== undefined && endDay - startDay + 1 <= MAX_DIRECT_DAY_BRANCHES) {
    const days = Array.from({ length: endDay - startDay + 1 }, (_, i) => startDay + i);
    const rows = await queryPgMultiDayWindow(
      client,
      scope,
      input.repoId,
      days,
      query.afterRevision,
      upperRevision,
      afterMs,
      beforeMs,
      batchLimit,
    );
    return finalizePgWindowPage(sourceRevision, upperRevision, query.limit, rows);
  }

  // Case D: Wide (> 32 days) or open-ended window — loose index skip-scan for active UTC days.
  const activeDays = await findPgActiveDays(client, scope, input.repoId, startDay, endDay, MAX_DIRECT_DAY_BRANCHES + 1);
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
    const rows = await queryPgMultiDayWindow(
      client,
      scope,
      input.repoId,
      activeDays,
      query.afterRevision,
      upperRevision,
      afterMs,
      beforeMs,
      batchLimit,
    );
    return finalizePgWindowPage(sourceRevision, upperRevision, query.limit, rows);
  }

  // Fallback for genuinely dense >32-day windows: batched pure PK scan filtering scalar occurred_at_ms.
  const matched: CanonicalEventV1[] = [];
  let cursorRev = query.afterRevision;
  while (matched.length < batchLimit && cursorRev < upperRevision) {
    const result = await client.query<{
      readonly revision: string;
      readonly occurred_at_ms: string | null;
      readonly event_json: string;
    }>(
      "SELECT revision, occurred_at_ms, event_json FROM ha_events " +
        "WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND revision>$4 AND revision<=$5 " +
        "ORDER BY revision ASC LIMIT $6",
      [scope.tenantId, scope.projectId, input.repoId, cursorRev, upperRevision, batchLimit],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      cursorRev = Number(row.revision);
      if (row.occurred_at_ms === null) continue;
      const ms = Number(row.occurred_at_ms);
      if (afterMs !== undefined && ms < afterMs) continue;
      if (beforeMs !== undefined && ms > beforeMs) continue;
      matched.push(JSON.parse(row.event_json) as CanonicalEventV1);
      if (matched.length >= batchLimit) break;
    }
    if (result.rows.length < batchLimit) break;
  }
  const hasMore = matched.length > query.limit;
  const events = hasMore ? matched.slice(0, query.limit) : matched;
  const lastScannedRevision = hasMore ? events.at(-1)!.workspaceRevision : upperRevision;
  return {
    sourceRevision,
    events,
    lastScannedRevision,
    windowMaxRevision: upperRevision,
    done: !hasMore,
  };
}

async function queryPgMultiDayWindow(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  days: readonly number[],
  afterRevision: number,
  upperRevision: number,
  afterMs: number | undefined,
  beforeMs: number | undefined,
  batchLimit: number,
): Promise<readonly { readonly event_json: string }[]> {
  const branches: string[] = [];
  const values: unknown[] = [
    scope.tenantId,
    scope.projectId,
    scope.policyEpoch,
    repoId,
    afterRevision,
    upperRevision,
    batchLimit,
  ];
  const startDay = afterMs === undefined ? undefined : Math.floor(afterMs / MS_PER_DAY);
  const endDay = beforeMs === undefined ? undefined : Math.floor(beforeMs / MS_PER_DAY);
  const push = (val: unknown) => {
    values.push(val);
    return `$${values.length}`;
  };
  for (const day of days) {
    const dayParam = push(day);
    const clauses = [
      "tenant_id=$1",
      "project_id=$2",
      "policy_epoch=$3",
      "repo_id=$4",
      `occurred_at_utc_day=${dayParam}`,
      "revision>$5",
      "revision<=$6",
    ];
    if (afterMs !== undefined && day === startDay && afterMs > day * MS_PER_DAY) {
      clauses.push(`occurred_at_ms>=${push(afterMs)}`);
    }
    if (beforeMs !== undefined && day === endDay && beforeMs < day * MS_PER_DAY + MS_PER_DAY - 1) {
      clauses.push(`occurred_at_ms<=${push(beforeMs)}`);
    }
    branches.push(`(SELECT revision FROM ha_events WHERE ${clauses.join(" AND ")} ORDER BY revision ASC LIMIT $7)`);
  }
  const revResult = await client.query<{ readonly revision: string }>(
    `SELECT revision FROM (${branches.join(" UNION ALL ")}) candidates ORDER BY revision ASC LIMIT $7`,
    values,
  );
  if (revResult.rows.length === 0) return [];
  const revisions = revResult.rows.map((row) => Number(row.revision));
  const eventResult = await client.query<{ readonly event_json: string }>(
    "SELECT event_json FROM ha_events " +
      "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision = ANY($5::bigint[]) " +
      "ORDER BY revision ASC",
    [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, revisions],
  );
  return eventResult.rows;
}

async function findPgActiveDays(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  startDay: number | undefined,
  endDay: number | undefined,
  maxDays: number,
): Promise<number[]> {
  const values: unknown[] = [scope.tenantId, scope.projectId, scope.policyEpoch, repoId];
  const push = (val: unknown) => {
    values.push(val);
    return `$${values.length}`;
  };
  const baseScope = "tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4";
  const initClauses = [baseScope, "occurred_at_utc_day IS NOT NULL"];
  const stepClauses = [baseScope, "occurred_at_utc_day>days.d"];
  if (startDay !== undefined) {
    initClauses.push(`occurred_at_utc_day>=${push(startDay)}`);
  }
  if (endDay !== undefined) {
    const endParam = push(endDay);
    initClauses.push(`occurred_at_utc_day<=${endParam}`);
    stepClauses.push(`occurred_at_utc_day<=${endParam}`);
  }
  const limitParam = push(maxDays);
  const result = await client.query<{ readonly d: number }>(
    `WITH RECURSIVE days(d) AS (` +
      `SELECT MIN(occurred_at_utc_day) FROM ha_events WHERE ${initClauses.join(" AND ")} ` +
      `UNION ALL ` +
      `SELECT (SELECT MIN(occurred_at_utc_day) FROM ha_events WHERE ${stepClauses.join(" AND ")}) ` +
      `FROM days WHERE days.d IS NOT NULL` +
      `) SELECT d FROM days WHERE d IS NOT NULL LIMIT ${limitParam}`,
    values,
  );
  return result.rows.map((row) => Number(row.d));
}

function finalizePgWindowPage(
  sourceRevision: number,
  upperRevision: number,
  limit: number,
  rows: readonly { readonly event_json: string }[],
): PgReadEventWindowResult {
  const hasMore = rows.length > limit;
  const events = (hasMore ? rows.slice(0, limit) : rows).map((row) => JSON.parse(row.event_json) as CanonicalEventV1);
  const lastScannedRevision = hasMore ? events.at(-1)!.workspaceRevision : upperRevision;
  return {
    sourceRevision,
    events,
    lastScannedRevision,
    windowMaxRevision: upperRevision,
    done: !hasMore,
  };
}
