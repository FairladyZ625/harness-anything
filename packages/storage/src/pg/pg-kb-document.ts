// Postgres/PGlite half of the shared KB document read model (dec_D75C5F36D3E0C4D2346D4B3961):
// the same kernel reducer as SQLite, folded in the canonical event transaction into generic
// projection values with repository-scope RLS readers.
//   kb-document  owner="kb"  entity=docId  KbDocumentRecord
import type { Pool, PoolClient } from "pg";
import {
  KB_DOCUMENT_EVENT_SCHEMA,
  KB_DOCUMENT_MODEL_VERSION,
  isKbDocumentEvent,
  kbDocumentCursor,
  kbDocumentEventTypes,
  kbDocumentNextCursor,
  kbDocumentPageLimit,
  matchesKbDocumentListFilter,
  reduceKbDocumentEvent,
  type KbDocumentEventV1,
  type KbDocumentQuery,
  type KbDocumentRead,
  type KbDocumentRecord,
} from "@harness-anything/kernel/internal/domain/kb-document-event.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import { getPgProjectionValue, putPgProjectionValue } from "./pg-projection-values.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

const MODEL = "kb-document",
  OWNER = "kb";

/** Fold one accepted KB document event into Postgres/PGlite projection values. */
export async function projectPgKbDocument(
  client: PoolClient,
  scope: PgProjectionScope,
  event: { readonly schema: string; readonly type: string },
): Promise<void> {
  if (!isKbDocumentEvent(event)) return;
  const input = event as KbDocumentEventV1,
    existing = await getPgProjectionValue<KbDocumentRecord>(client, scope, MODEL, input.payload.docId, OWNER),
    next = reduceKbDocumentEvent(existing, input);
  await putPgProjectionValue(client, scope, MODEL, input.payload.docId, OWNER, input.workspaceRevision, next);
}

async function kbDocumentModelCurrent(client: PoolClient, scope: PgProjectionScope): Promise<boolean> {
  const meta = await client.query<{ kb_document_version: number }>(
    `SELECT kb_document_version FROM ha_projection_meta
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  return (meta.rows[0]?.kb_document_version ?? KB_DOCUMENT_MODEL_VERSION) === KB_DOCUMENT_MODEL_VERSION;
}

/** Refold KB document events when the projection meta row names an older model version. */
export async function backfillPgKbDocuments(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
): Promise<number> {
  const keys = [scope.tenantId, scope.projectId, repoId];
  await client.query(
    "SELECT revision FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 FOR UPDATE",
    keys,
  );
  if (await kbDocumentModelCurrent(client, scope)) return 0;
  await client.query(
    "DELETE FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model = $4",
    [scope.tenantId, scope.projectId, scope.policyEpoch, MODEL],
  );
  const events = await client.query<{ event_json: string; readers: string[] }>(
    `SELECT event_json, readers FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3
     AND event_schema=$4 AND event_type = ANY($5::text[]) ORDER BY revision`,
    [...keys, KB_DOCUMENT_EVENT_SCHEMA, [...kbDocumentEventTypes]],
  );
  let folded = 0;
  for (const row of events.rows) {
    const event = JSON.parse(row.event_json) as { readonly schema: string; readonly type: string };
    if (!isKbDocumentEvent(event)) continue;
    await projectPgKbDocument(client, { ...scope, readers: row.readers }, event);
    folded += 1;
  }
  await client.query(
    `UPDATE ha_projection_meta SET kb_document_version=$4
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, KB_DOCUMENT_MODEL_VERSION],
  );
  return folded;
}

async function readList(
  client: PoolClient,
  scope: PostgresScopeClaims,
  readers: readonly string[],
  query: Extract<KbDocumentQuery, { by: "list" }>,
): Promise<{ readonly records: readonly KbDocumentRecord[]; readonly nextCursor: string | null }> {
  const limit = kbDocumentPageLimit(query.limit);
  let afterKey = kbDocumentCursor(query.cursor);
  const matched: KbDocumentRecord[] = [];
  const batchSize = Math.max(limit + 1, 64);
  for (;;) {
    const rows = (
      await client.query<{ entity_id: string; value: string }>(
        `SELECT entity_id, value FROM ha_projection_values
         WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
           AND model='${MODEL}' AND owner_id='${OWNER}'
           AND (cardinality($4::text[])=0 OR readers && $4::text[])
           AND entity_id COLLATE "C" > $5
         ORDER BY entity_id COLLATE "C" LIMIT $6`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, [...readers], afterKey, batchSize],
      )
    ).rows;
    if (rows.length === 0) break;
    for (const row of rows) {
      afterKey = row.entity_id;
      const record = JSON.parse(row.value) as KbDocumentRecord;
      if (matchesKbDocumentListFilter(record, query)) {
        matched.push(record);
        if (matched.length > limit) break;
      }
    }
    if (matched.length > limit || rows.length < batchSize) break;
  }
  return {
    records: matched.slice(0, limit),
    nextCursor: kbDocumentNextCursor(matched, limit),
  };
}

export interface PgKbDocumentQueries {
  readonly readKbDocuments: (query: KbDocumentQuery) => Promise<KbDocumentRead>;
}

export function pgKbDocumentQueries(options: {
  readonly pool: Pool;
  readonly scope: PostgresScopeClaims & { readonly readers?: readonly string[] };
  readonly repoId: string;
}): PgKbDocumentQueries {
  const scope = options.scope,
    readers = [...(scope.readers ?? [])],
    valueScope = { ...scope, readers };
  return {
    readKbDocuments: (query) =>
      withPostgresTransaction(
        options.pool,
        async (client) => {
          const cut = await readCutInTransaction(client, scope, readers, options.repoId);
          if (cut.status !== "ready" || !(await kbDocumentModelCurrent(client, scope)))
            return { status: "pending", watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          const base = { status: "ready" as const, watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          if (query.by === "list") return { ...base, ...(await readList(client, scope, readers, query)) };
          const record = await getPgProjectionValue<KbDocumentRecord>(client, valueScope, MODEL, query.docId, OWNER);
          return { ...base, records: record === null ? [] : [record], nextCursor: null };
        },
        scope,
        { isolationLevel: "repeatable read" },
      ),
  };
}
