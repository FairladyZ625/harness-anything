// Postgres/PGlite half of the Inbox read model (dec_7CE3162BF9BFB157DAB9F9B6C0 CH1): the same kernel item
// reducer as SQLite, folded in the canonical event transaction into generic projection values. No Inbox
// state is inferred in SQL. Three models keep every read indexed and every fold O(1) items:
//   inbox-item   owner=inboxId entity=itemId                         the item
//   inbox-dedupe owner=inboxId entity=dedupeKey                      the item id holding that dedupe key
//   inbox-queue  owner=inboxId entity=<status>:<enqueuedRevision/16>  non-terminal items in enqueue order
// A projection written before this model existed carries an older `inbox_version` in its meta row: reads
// are pending until the backfill refolds the Inbox events through the same reducer.
import type { Pool, PoolClient } from "pg";
import {
  INBOX_MODEL_VERSION,
  inboxEventTypes,
  inboxItemLookup,
  inboxPageLimit,
  inboxQueueCursor,
  inboxQueueNextCursor,
  inboxQueueStatuses,
  isInboxEvent,
  isTerminalInboxStatus,
  reduceInboxItem,
  type InboxEvent,
  type InboxItem,
  type InboxQuery,
  type InboxRead,
} from "@harness-anything/kernel/internal/domain/inbox.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import { deletePgProjectionValue, getPgProjectionValue, putPgProjectionValue } from "./pg-projection-values.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

const ITEM = "inbox-item",
  DEDUPE = "inbox-dedupe",
  QUEUE = "inbox-queue",
  HISTORY = "inbox-history";
const MODELS = [ITEM, DEDUPE, QUEUE, HISTORY] as const;

function queueKey(consumerKind: string, status: string, enqueuedRevision: number): string {
  return `${consumerKind}:${status}:${String(enqueuedRevision).padStart(16, "0")}`;
}

function historyKey(enqueuedRevision: number): string {
  return String(enqueuedRevision).padStart(16, "0");
}

function projectionScopeForItem(scope: PgProjectionScope, item: InboxItem): PgProjectionScope {
  if (!item.inboxId.startsWith("person:")) return scope;
  const recipientPersonId = item.inboxId.slice("person:".length);
  const readers = new Set([...(scope.readers ?? []), recipientPersonId]);
  if (item.senderPersonId !== null) readers.add(item.senderPersonId);
  return {
    ...scope,
    readers: [...readers],
  };
}

async function addressedItem(client: PoolClient, scope: PgProjectionScope, event: InboxEvent) {
  const lookup = inboxItemLookup(event),
    byId = await getPgProjectionValue<InboxItem>(client, scope, ITEM, lookup.itemId, lookup.inboxId);
  if (byId !== null || lookup.dedupeKey === null) return byId;
  const itemId = await getPgProjectionValue<string>(client, scope, DEDUPE, lookup.dedupeKey, lookup.inboxId);
  return itemId === null ? null : getPgProjectionValue<InboxItem>(client, scope, ITEM, itemId, lookup.inboxId);
}

/** Fold one accepted event; an ignored step leaves every Inbox model unchanged. */
export async function projectPgInbox(
  client: PoolClient,
  scope: PgProjectionScope,
  event: { readonly schema: string; readonly type: string },
): Promise<void> {
  if (!isInboxEvent(event)) return;
  const input = event as InboxEvent,
    current = await addressedItem(client, scope, input),
    step = reduceInboxItem(current, input);
  if (step.kind !== "applied") return;
  const item = step.item,
    revision = input.workspaceRevision,
    itemScope = projectionScopeForItem(scope, item);
  await putPgProjectionValue(client, itemScope, ITEM, item.itemId, item.inboxId, revision, item);
  await putPgProjectionValue(
    client,
    itemScope,
    HISTORY,
    historyKey(item.enqueuedRevision),
    item.inboxId,
    revision,
    item,
  );
  if (current === null)
    await putPgProjectionValue(client, itemScope, DEDUPE, item.dedupeKey, item.inboxId, revision, item.itemId);
  else
    await deletePgProjectionValue(
      client,
      scope,
      QUEUE,
      queueKey(current.consumerKind, current.status, current.enqueuedRevision),
      current.inboxId,
    );
  if (!isTerminalInboxStatus(item.status))
    await putPgProjectionValue(
      client,
      itemScope,
      QUEUE,
      queueKey(item.consumerKind, item.status, item.enqueuedRevision),
      item.inboxId,
      revision,
      item,
    );
}

async function inboxModelCurrent(client: PoolClient, scope: PgProjectionScope): Promise<boolean> {
  const meta = await client.query<{ inbox_version: number }>(
    `SELECT inbox_version FROM ha_projection_meta
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  // No meta row yet means no events were folded: the (empty) model is current.
  return (meta.rows[0]?.inbox_version ?? INBOX_MODEL_VERSION) === INBOX_MODEL_VERSION;
}

/**
 * Refold the Inbox model of a projection whose meta row names an older model version: O(Inbox events) once,
 * under the repository head lock so no append interleaves; later calls are a single meta read.
 */
export async function backfillPgInbox(client: PoolClient, scope: PgProjectionScope, repoId: string): Promise<number> {
  const keys = [scope.tenantId, scope.projectId, repoId];
  await client.query(
    "SELECT revision FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 FOR UPDATE",
    keys,
  );
  if (await inboxModelCurrent(client, scope)) return 0;
  await client.query(
    "DELETE FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model = ANY($4::text[])",
    [scope.tenantId, scope.projectId, scope.policyEpoch, [...MODELS]],
  );
  const events = await client.query<{ event_json: string; readers: string[] }>(
    `SELECT event_json, readers FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3
     AND event_schema='agent-runtime-event/v1' AND event_type = ANY($4::text[]) ORDER BY revision`,
    [...keys, [...inboxEventTypes]],
  );
  let folded = 0;
  for (const row of events.rows) {
    const event = JSON.parse(row.event_json) as { readonly schema: string; readonly type: string };
    if (!isInboxEvent(event)) continue;
    await projectPgInbox(client, { ...scope, readers: row.readers }, event);
    folded += 1;
  }
  await client.query(
    `UPDATE ha_projection_meta SET inbox_version=$4
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, INBOX_MODEL_VERSION],
  );
  return folded;
}

async function readQueue(
  client: PoolClient,
  scope: PostgresScopeClaims,
  readers: readonly string[],
  query: Extract<InboxQuery, { by: "queue" }>,
): Promise<{ readonly items: readonly InboxItem[]; readonly nextCursor: string | null }> {
  if (!(inboxQueueStatuses as readonly string[]).includes(query.status))
    throw new Error(`inbox queue status is not a queue: ${String(query.status)}`);
  if (query.consumerKind === "interactive_watch" && (typeof query.inboxId !== "string" || query.inboxId.length === 0))
    throw new Error("interactive watch Inbox reads require a targeted inboxId");
  const limit = inboxPageLimit(query.limit),
    consumerPrefix = `${query.consumerKind}:${query.status}:`,
    values: unknown[] = [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...readers],
      `${consumerPrefix}${String(inboxQueueCursor(query.cursor)).padStart(16, "0")}`,
      `${query.consumerKind}:${query.status};`,
    ],
    predicates = [
      "tenant_id=$1",
      "project_id=$2",
      "policy_epoch=$3",
      `model='${QUEUE}'`,
      "(cardinality($4::text[])=0 OR readers && $4::text[])",
      'entity_id COLLATE "C" > $5',
      'entity_id COLLATE "C" < $6',
    ];
  if (query.inboxId !== undefined) {
    values.push(query.inboxId);
    predicates.push(`owner_id=$${values.length}`);
  }
  values.push(limit + 1);
  const items = (
    await client.query<{ value: string }>(
      `SELECT value FROM ha_projection_values WHERE ${predicates.join(" AND ")}
       ORDER BY entity_id COLLATE "C" LIMIT $${values.length}`,
      values,
    )
  ).rows.map(({ value }) => JSON.parse(value) as InboxItem);
  return { items: items.slice(0, limit), nextCursor: inboxQueueNextCursor(items, limit) };
}

async function readHistory(
  client: PoolClient,
  scope: PostgresScopeClaims,
  readers: readonly string[],
  query: Extract<InboxQuery, { by: "inbox" }>,
): Promise<{ readonly items: readonly InboxItem[]; readonly nextCursor: string | null }> {
  if (typeof query.inboxId !== "string" || query.inboxId.length === 0)
    throw new Error("inbox history reads require a targeted inboxId");
  const limit = inboxPageLimit(query.limit);
  const items = (
    await client.query<{ value: string }>(
      `SELECT value FROM ha_projection_values
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
         AND model='${HISTORY}' AND owner_id=$4
         AND (cardinality($5::text[])=0 OR readers && $5::text[])
         AND entity_id COLLATE "C" > $6
       ORDER BY entity_id COLLATE "C" LIMIT $7`,
      [
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        query.inboxId,
        [...readers],
        historyKey(inboxQueueCursor(query.cursor)),
        limit + 1,
      ],
    )
  ).rows.map(({ value }) => JSON.parse(value) as InboxItem);
  return { items: items.slice(0, limit), nextCursor: inboxQueueNextCursor(items, limit) };
}

export interface PgInboxQueries {
  readonly readInbox: (query: InboxQuery) => Promise<InboxRead>;
}

export function pgInboxQueries(options: {
  readonly pool: Pool;
  readonly scope: PostgresScopeClaims & { readonly readers?: readonly string[] };
  readonly repoId: string;
}): PgInboxQueries {
  const scope = options.scope,
    readers = [...(scope.readers ?? [])],
    valueScope = { ...scope, readers };
  return {
    readInbox: (query) =>
      withPostgresTransaction(
        options.pool,
        async (client) => {
          const cut = await readCutInTransaction(client, scope, readers, options.repoId);
          if (cut.status !== "ready" || !(await inboxModelCurrent(client, scope)))
            return { status: "pending", watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          const base = { status: "ready" as const, watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          if (query.by === "queue") return { ...base, ...(await readQueue(client, scope, readers, query)) };
          if (query.by === "inbox") return { ...base, ...(await readHistory(client, scope, readers, query)) };
          const itemId =
            query.by === "item"
              ? query.itemId
              : await getPgProjectionValue<string>(client, valueScope, DEDUPE, query.dedupeKey, query.inboxId);
          const item =
            itemId === null
              ? null
              : await getPgProjectionValue<InboxItem>(client, valueScope, ITEM, itemId, query.inboxId);
          return { ...base, items: item === null ? [] : [item], nextCursor: null };
        },
        scope,
        { isolationLevel: "repeatable read" },
      ),
  };
}
