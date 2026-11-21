import type { PoolClient } from "pg";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  storageReadPolicy,
  validateStorageReadWindow,
} from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import {
  TaskEventStoreError,
  type AuditEventWindowBatch,
  type AuditEventWindowQuery,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { PostgresEventStoreScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";
import { auditWindowRevisionKey, collectAuditWindowRevisions } from "../store/audit-window-revisions.ts";

const MIN_JS_EPOCH_MS = -8_640_000_000_000_000;
const MAX_JS_EPOCH_MS = 8_640_000_000_000_000;

export interface PgReadEventWindowPayload {
  readonly repoId: string;
  readonly query: AuditEventWindowQuery;
}

export async function readPgEventWindow(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  input: PgReadEventWindowPayload,
  sourceRevision: number,
  history?: string,
): Promise<AuditEventWindowBatch> {
  const { query } = input;
  if (!validateStorageReadWindow(query.limit, undefined, query.afterRevision))
    throw new TaskEventStoreError("invalid_store", "event window cursor or size is invalid");
  const upperRevision = Math.min(sourceRevision, query.maxRevision ?? sourceRevision);
  const afterMs = query.after === undefined ? MIN_JS_EPOCH_MS : Date.parse(query.after);
  const beforeMs = query.before === undefined ? MAX_JS_EPOCH_MS : Date.parse(query.before);
  const batchLimit = query.limit + 1;
  const batch = (
    rows: readonly { readonly event_json: string }[],
    hasMore = false,
    continuation?: string,
  ): AuditEventWindowBatch => {
    const events = rows.map((row) => JSON.parse(row.event_json) as CanonicalEventV1);
    return {
      sourceRevision,
      events,
      windowMaxRevision: upperRevision,
      lastScannedRevision: hasMore ? events.at(-1)!.workspaceRevision : Math.max(query.afterRevision, upperRevision),
      done: !hasMore,
      ...(continuation === undefined ? {} : { continuation }),
    };
  };
  if (query.afterRevision >= upperRevision || !(afterMs <= beforeMs)) return batch([]);
  if (query.after === undefined && query.before === undefined) {
    const result = await client.query<{ readonly event_json: string }>(
      "SELECT event_json FROM ha_events " +
        "WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND revision>$4 AND revision<=$5 " +
        "ORDER BY revision LIMIT $6",
      [scope.tenantId, scope.projectId, input.repoId, query.afterRevision, upperRevision, batchLimit],
    );
    return batch(result.rows.slice(0, query.limit), result.rows.length > query.limit);
  }

  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch, input.repoId];
  // Bind scratch to the confirmed replication history, including after a repository restore.
  const key = auditWindowRevisionKey({ scope: ["pg", ...keys, history ?? ""], afterMs, beforeMs, upperRevision });
  await pgOccurredAtMsGate(client, keys);
  let page = key.read(query.continuation, query.afterRevision, query.limit);
  if (page === null) {
    const collected = collectAuditWindowRevisions(key, query.afterRevision, query.limit);
    try {
      // A server cursor executes the sort once and exposes bounded FETCH batches.
      // Materializing revision keys alone keeps event bodies out of the sort.
      await client.query("SET LOCAL work_mem = '4MB'");
      await client.query(
        "DECLARE ha_audit_revisions NO SCROLL CURSOR FOR " +
          "WITH matched AS MATERIALIZED (SELECT revision FROM ha_events " +
          "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
          "AND occurred_at_ms>=$5 AND occurred_at_ms<=$6 AND revision>$7 AND revision<=$8) " +
          "SELECT revision FROM matched ORDER BY revision",
        [...keys, afterMs, beforeMs, query.afterRevision, upperRevision],
      );
      const fetchSize = storageReadPolicy.defaultValue.pageSizes.standard;
      for (;;) {
        const page = await client.query<{ readonly revision: string }>(
          `FETCH FORWARD ${fetchSize} FROM ha_audit_revisions`,
        );
        for (const row of page.rows) collected.append(Number(row.revision));
        if (page.rows.length < fetchSize) break;
      }
      await client.query("CLOSE ha_audit_revisions");
      page = collected.finish();
    } catch (error) {
      collected.abort();
      throw error;
    }
  }
  const { revisions, continuation } = page;
  if (revisions.length === 0) return batch([]);
  const result = await client.query<{ readonly event_json: string }>(
    "SELECT event_json FROM ha_events " +
      "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision=ANY($5::bigint[]) " +
      "ORDER BY revision",
    [...keys, revisions],
  );
  if (result.rows.length !== revisions.length)
    throw new TaskEventStoreError("invalid_store", "A selected audit-window revision is missing from the ledger");
  return batch(result.rows, continuation !== undefined, continuation);
}

async function pgOccurredAtMsGate(client: PoolClient, keys: (string | number)[]): Promise<void> {
  const pending = await client.query(
    "SELECT 1 FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 " +
      "AND occurred_at_ms IS NULL LIMIT 1",
    keys,
  );
  if (pending.rows.length > 0) {
    const error = new Error("Event occurred_at_ms index backfill is pending");
    Object.defineProperty(error, "code", { value: "projection_pending" });
    throw error;
  }
}
