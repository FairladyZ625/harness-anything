// Postgres/PGlite half of the PeerRequestV1 read model (dec_2B573FD17D82C9ADDE2FC69C5D CH2):
// the same kernel reducer as SQLite, folded in the canonical event transaction into generic
// projection values with dual-principal RLS readers (both sender and recipient).
//   peer-request      owner="peer" entity=requestId                     { openedRevision, request }
//   peer-request-list owner="peer" entity=<openedRevision/16>           { openedRevision, request }
import type { Pool, PoolClient } from "pg";
import {
  PEER_REQUEST_MODEL_VERSION,
  isPeerRequestEvent,
  peerRequestCursor,
  peerRequestEventRequestId,
  peerRequestEventTypes,
  peerRequestNextCursor,
  peerRequestPageLimit,
  reducePeerRequestEvent,
  type PeerRequestEventV1,
  type PeerRequestQuery,
  type PeerRequestRead,
  type PeerRequestV1,
} from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import { getPgProjectionValue, putPgProjectionValue } from "./pg-projection-values.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

const ITEM = "peer-request",
  LIST = "peer-request-list",
  OWNER = "peer";
const MODELS = [ITEM, LIST] as const;

interface StoredPeerRequest {
  readonly openedRevision: number;
  readonly request: PeerRequestV1;
}

function listKey(openedRevision: number): string {
  return String(openedRevision).padStart(16, "0");
}

function projectionScopeForRequest(scope: PgProjectionScope, request: PeerRequestV1): PgProjectionScope {
  const readers = new Set([...(scope.readers ?? []), request.from.personId, request.to.personId]);
  return {
    ...scope,
    readers: [...readers],
  };
}

/** Fold one accepted PeerRequest event into Postgres/PGlite projection values. */
export async function projectPgPeerRequest(
  client: PoolClient,
  scope: PgProjectionScope,
  event: { readonly schema: string; readonly type: string },
): Promise<void> {
  if (!isPeerRequestEvent(event)) return;
  const input = event as PeerRequestEventV1,
    requestId = peerRequestEventRequestId(input),
    existing = await getPgProjectionValue<StoredPeerRequest>(client, scope, ITEM, requestId, OWNER),
    next = reducePeerRequestEvent(existing?.request ?? null, input),
    openedRevision = existing?.openedRevision ?? input.workspaceRevision,
    stored: StoredPeerRequest = { openedRevision, request: next },
    itemScope = projectionScopeForRequest(scope, next),
    revision = input.workspaceRevision;
  await putPgProjectionValue(client, itemScope, ITEM, requestId, OWNER, revision, stored);
  await putPgProjectionValue(client, itemScope, LIST, listKey(openedRevision), OWNER, revision, stored);
}

async function peerRequestModelCurrent(client: PoolClient, scope: PgProjectionScope): Promise<boolean> {
  const meta = await client.query<{ peer_request_version: number }>(
    `SELECT peer_request_version FROM ha_projection_meta
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  return (meta.rows[0]?.peer_request_version ?? PEER_REQUEST_MODEL_VERSION) === PEER_REQUEST_MODEL_VERSION;
}

/** Refold PeerRequest events when the projection meta row names an older model version. */
export async function backfillPgPeerRequests(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
): Promise<number> {
  const keys = [scope.tenantId, scope.projectId, repoId];
  await client.query(
    "SELECT revision FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 FOR UPDATE",
    keys,
  );
  if (await peerRequestModelCurrent(client, scope)) return 0;
  await client.query(
    "DELETE FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model = ANY($4::text[])",
    [scope.tenantId, scope.projectId, scope.policyEpoch, [...MODELS]],
  );
  const events = await client.query<{ event_json: string; readers: string[] }>(
    `SELECT event_json, readers FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3
     AND event_schema='peer-request-event/v1' AND event_type = ANY($4::text[]) ORDER BY revision`,
    [...keys, [...peerRequestEventTypes]],
  );
  let folded = 0;
  for (const row of events.rows) {
    const event = JSON.parse(row.event_json) as { readonly schema: string; readonly type: string };
    if (!isPeerRequestEvent(event)) continue;
    await projectPgPeerRequest(client, { ...scope, readers: row.readers }, event);
    folded += 1;
  }
  await client.query(
    `UPDATE ha_projection_meta SET peer_request_version=$4
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, PEER_REQUEST_MODEL_VERSION],
  );
  return folded;
}

function matchesListFilter(request: PeerRequestV1, query: Extract<PeerRequestQuery, { by: "list" }>): boolean {
  if (query.recipientPersonId !== undefined && request.to.personId !== query.recipientPersonId) return false;
  if (query.senderPersonId !== undefined && request.from.personId !== query.senderPersonId) return false;
  if (query.state !== undefined && request.state !== query.state) return false;
  if (query.kind !== undefined && request.kind !== query.kind) return false;
  if (query.workId !== undefined && request.to.workId !== query.workId) return false;
  if (query.lane !== undefined && request.to.lane !== query.lane) return false;
  return true;
}

async function readList(
  client: PoolClient,
  scope: PostgresScopeClaims,
  readers: readonly string[],
  query: Extract<PeerRequestQuery, { by: "list" }>,
): Promise<{ readonly requests: readonly PeerRequestV1[]; readonly nextCursor: string | null }> {
  const limit = peerRequestPageLimit(query.limit);
  let afterKey = listKey(peerRequestCursor(query.cursor));
  const matched: StoredPeerRequest[] = [];
  const batchSize = Math.max(limit + 1, 64);
  for (;;) {
    const rows = (
      await client.query<{ entity_id: string; value: string }>(
        `SELECT entity_id, value FROM ha_projection_values
         WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
           AND model='${LIST}' AND owner_id='${OWNER}'
           AND (cardinality($4::text[])=0 OR readers && $4::text[])
           AND entity_id COLLATE "C" > $5
         ORDER BY entity_id COLLATE "C" LIMIT $6`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, [...readers], afterKey, batchSize],
      )
    ).rows;
    if (rows.length === 0) break;
    for (const row of rows) {
      afterKey = row.entity_id;
      const stored = JSON.parse(row.value) as StoredPeerRequest;
      if (matchesListFilter(stored.request, query)) {
        matched.push(stored);
        if (matched.length > limit) break;
      }
    }
    if (matched.length > limit || rows.length < batchSize) break;
  }
  return {
    requests: matched.slice(0, limit).map(({ request }) => request),
    nextCursor: peerRequestNextCursor(matched, limit),
  };
}

export interface PgPeerRequestQueries {
  readonly readPeerRequests: (query: PeerRequestQuery) => Promise<PeerRequestRead>;
}

export function pgPeerRequestQueries(options: {
  readonly pool: Pool;
  readonly scope: PostgresScopeClaims & { readonly readers?: readonly string[] };
  readonly repoId: string;
}): PgPeerRequestQueries {
  const scope = options.scope,
    readers = [...(scope.readers ?? [])],
    valueScope = { ...scope, readers };
  return {
    readPeerRequests: (query) =>
      withPostgresTransaction(
        options.pool,
        async (client) => {
          const cut = await readCutInTransaction(client, scope, readers, options.repoId);
          if (cut.status !== "ready" || !(await peerRequestModelCurrent(client, scope)))
            return { status: "pending", watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          const base = { status: "ready" as const, watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          if (query.by === "list") return { ...base, ...(await readList(client, scope, readers, query)) };
          const stored = await getPgProjectionValue<StoredPeerRequest>(
            client,
            valueScope,
            ITEM,
            query.requestId,
            OWNER,
          );
          return { ...base, requests: stored === null ? [] : [stored.request], nextCursor: null };
        },
        scope,
        { isolationLevel: "repeatable read" },
      ),
  };
}
