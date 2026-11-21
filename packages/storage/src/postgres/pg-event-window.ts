import type { PoolClient } from "pg";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { validateStorageReadWindow } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { PostgresEventStoreScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";

const MIN_JS_EPOCH_MS = -8_640_000_000_000_000;
const MAX_JS_EPOCH_MS = 8_640_000_000_000_000;

export interface PgReadEventWindowPayload {
  readonly repoId: string;
  readonly query: {
    readonly afterRevision: number;
    readonly maxRevision?: number;
    readonly after?: string;
    readonly before?: string;
    readonly limit: number;
    readonly afterOccurredAtMs?: number;
  };
}

export interface PgReadEventWindowResult {
  readonly sourceRevision: number;
  readonly events: readonly CanonicalEventV1[];
  readonly lastScannedRevision: number;
  readonly windowMaxRevision: number;
  readonly done: boolean;
  readonly nextAfterOccurredAtMs?: number;
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
    return finalizePgEventRows(sourceRevision, upperRevision, query.limit, result.rows);
  }

  // Fail closed via the tiny partial pending index if historical rows have not yet been backfilled.
  await pgOccurredAtMsGate(client, scope, input.repoId);

  // Case 1: Exact millisecond window (equal endpoints) — direct RLS-safe index seek on (occurred_at_ms, revision).
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
    return finalizePgEventRows(sourceRevision, upperRevision, query.limit, result.rows, afterMs);
  }

  const baseLowerMs = afterMs ?? MIN_JS_EPOCH_MS;
  const upperMs = beforeMs ?? MAX_JS_EPOCH_MS;
  const keysetMs =
    query.afterOccurredAtMs !== undefined && query.afterOccurredAtMs >= baseLowerMs
      ? query.afterOccurredAtMs
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
  const peek = await peekPgOccurredAtMs(
    client,
    scope,
    input.repoId,
    lowerMs,
    upperMs,
    keysetMs,
    query.afterRevision,
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
    return fetchPgRevisionsPage(client, scope, input.repoId, sourceRevision, upperRevision, revisions, false);
  }

  // Fast exit 2A: contiguous revision prefix from afterRevision + 1 proves no later timestamp can hold a smaller revision.
  let contiguous = true;
  for (let index = 0; index < query.limit; index += 1) {
    if (peek[index]!.revision !== query.afterRevision + 1 + index) {
      contiguous = false;
      break;
    }
  }
  if (contiguous) {
    const selectedRevs = peek.slice(0, query.limit).map((row) => row.revision);
    return fetchPgRevisionsPage(
      client,
      scope,
      input.repoId,
      sourceRevision,
      upperRevision,
      selectedRevs,
      true,
      peek[query.limit - 1]!.ms,
    );
  }

  // Fast exit 2B: all peeked rows share the final active timestamp in [lowerMs, upperMs], already ordered by revision ASC.
  const firstMs = peek[0]!.ms;
  const lastMs = peek[query.limit]!.ms;
  if (firstMs === lastMs) {
    const later =
      firstMs >= upperMs
        ? { rows: [] }
        : await client.query(
            "SELECT 1 FROM ha_events " +
              "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
              "AND occurred_at_ms>$5 AND occurred_at_ms<=$6 AND revision>$7 AND revision<=$8 " +
              "LIMIT 1",
            [
              scope.tenantId,
              scope.projectId,
              scope.policyEpoch,
              input.repoId,
              firstMs,
              upperMs,
              query.afterRevision,
              upperRevision,
            ],
          );
    if (later.rows.length === 0) {
      const selectedRevs = peek.slice(0, query.limit).map((row) => row.revision);
      return fetchPgRevisionsPage(
        client,
        scope,
        input.repoId,
        sourceRevision,
        upperRevision,
        selectedRevs,
        true,
        firstMs,
      );
    }
  }

  // Case 3: Gapped or non-monotonic window — MATERIALIZED CTE forces RLS-safe index scan on ha_events_occurred_ms_revision
  // over [lowerMs, upperMs] only (zero non-matching rows scanned), then Top-N sorts the matched integer revisions.
  const revResult = await client.query<{ readonly revision: string }>(
    "WITH matched AS MATERIALIZED (" +
      "SELECT revision FROM ha_events " +
      "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
      "AND occurred_at_ms>=$5 AND occurred_at_ms<=$6 AND revision>$7 AND revision<=$8" +
      ") SELECT revision FROM matched ORDER BY revision ASC LIMIT $9",
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      input.repoId,
      lowerMs,
      upperMs,
      query.afterRevision,
      upperRevision,
      batchLimit,
    ],
  );
  const hasMore = revResult.rows.length > query.limit;
  const selectedRevs = (hasMore ? revResult.rows.slice(0, query.limit) : revResult.rows).map((row) =>
    Number(row.revision),
  );
  return fetchPgRevisionsPage(
    client,
    scope,
    input.repoId,
    sourceRevision,
    upperRevision,
    selectedRevs,
    hasMore,
    keysetMs,
  );
}

async function pgOccurredAtMsGate(client: PoolClient, scope: PostgresEventStoreScope, repoId: string): Promise<void> {
  const pending = await client.query(
    "SELECT 1 FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
      "AND occurred_at_ms IS NULL LIMIT 1",
    [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
  );
  if (pending.rows.length > 0) {
    const error = new Error("Event occurred_at_ms index backfill is pending");
    Object.defineProperty(error, "code", { value: "projection_pending" });
    throw error;
  }
}

async function peekPgOccurredAtMs(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  lowerMs: number,
  upperMs: number,
  keysetMs: number | undefined,
  afterRevision: number,
  upperRevision: number,
  batchLimit: number,
): Promise<{ readonly ms: number; readonly revision: number }[]> {
  if (keysetMs !== undefined) {
    const partA = await client.query<{ readonly occurred_at_ms: string; readonly revision: string }>(
      "SELECT occurred_at_ms, revision FROM ha_events " +
        "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
        "AND occurred_at_ms=$5 AND revision>$6 AND revision<=$7 " +
        "ORDER BY revision ASC LIMIT $8",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, keysetMs, afterRevision, upperRevision, batchLimit],
    );
    const result = partA.rows.map((row) => ({ ms: Number(row.occurred_at_ms), revision: Number(row.revision) }));
    if (result.length < batchLimit && keysetMs < upperMs) {
      const partB = await client.query<{ readonly occurred_at_ms: string; readonly revision: string }>(
        "SELECT occurred_at_ms, revision FROM ha_events " +
          "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
          "AND occurred_at_ms>$5 AND occurred_at_ms<=$6 AND revision>$7 AND revision<=$8 " +
          "ORDER BY occurred_at_ms ASC, revision ASC LIMIT $9",
        [
          scope.tenantId,
          scope.projectId,
          scope.policyEpoch,
          repoId,
          keysetMs,
          upperMs,
          afterRevision,
          upperRevision,
          batchLimit - result.length,
        ],
      );
      for (const row of partB.rows) {
        result.push({ ms: Number(row.occurred_at_ms), revision: Number(row.revision) });
      }
    }
    return result;
  }
  const rows = await client.query<{ readonly occurred_at_ms: string; readonly revision: string }>(
    "SELECT occurred_at_ms, revision FROM ha_events " +
      "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
      "AND occurred_at_ms>=$5 AND occurred_at_ms<=$6 AND revision>$7 AND revision<=$8 " +
      "ORDER BY occurred_at_ms ASC, revision ASC LIMIT $9",
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      repoId,
      lowerMs,
      upperMs,
      afterRevision,
      upperRevision,
      batchLimit,
    ],
  );
  return rows.rows.map((row) => ({ ms: Number(row.occurred_at_ms), revision: Number(row.revision) }));
}

async function fetchPgRevisionsPage(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  sourceRevision: number,
  upperRevision: number,
  revisions: readonly number[],
  hasMore: boolean,
  nextAfterOccurredAtMs?: number,
): Promise<PgReadEventWindowResult> {
  if (revisions.length === 0) {
    return {
      sourceRevision,
      events: [],
      lastScannedRevision: upperRevision,
      windowMaxRevision: upperRevision,
      done: true,
    };
  }
  const eventResult = await client.query<{ readonly event_json: string }>(
    "SELECT event_json FROM ha_events " +
      "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision = ANY($5::bigint[]) " +
      "ORDER BY revision ASC",
    [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, revisions],
  );
  const events = eventResult.rows.map((row) => JSON.parse(row.event_json) as CanonicalEventV1);
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

function finalizePgEventRows(
  sourceRevision: number,
  upperRevision: number,
  limit: number,
  rows: readonly { readonly event_json: string }[],
  nextAfterOccurredAtMs?: number,
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
    ...(hasMore && nextAfterOccurredAtMs !== undefined ? { nextAfterOccurredAtMs } : {}),
  };
}
