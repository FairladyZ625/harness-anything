import type { Pool, PoolClient } from "pg";
import {
  RUNTIME_INBOX_MODEL_VERSION,
  RUNTIME_INBOX_PAGE_LIMIT,
  inboxHasOpenItems,
  isRuntimeInboxInput,
  reduceRuntimeInbox,
  type RuntimeInboxGroup,
  type RuntimeInboxInput,
  type RuntimeInboxQuery,
  type RuntimeInboxRead,
} from "@harness-anything/kernel/internal/domain/runtime-inbox.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import { deletePgProjectionValue, getPgProjectionValue, putPgProjectionValue } from "./pg-projection-values.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

const MODEL_GROUP = "runtime-inbox-group",
  MODEL_OPEN = "runtime-inbox-open";
const MODELS = [MODEL_GROUP, MODEL_OPEN] as const;

/** Fold one accepted event into PG/PGlite projection values using the shared kernel reducer. */
export async function projectPgRuntimeInbox(
  client: PoolClient,
  scope: PgProjectionScope,
  event: { readonly schema: string; readonly type: string },
): Promise<void> {
  if (!isRuntimeInboxInput(event)) return;
  const input = event as RuntimeInboxInput,
    revision = input.workspaceRevision,
    previous = await getPgProjectionValue<RuntimeInboxGroup>(client, scope, MODEL_GROUP, input.payload.inboxId),
    step = reduceRuntimeInbox(previous, input);
  if (step.kind !== "applied") return;
  const group = step.group;
  await putPgProjectionValue(client, scope, MODEL_GROUP, group.inboxId, "", revision, group);
  if (inboxHasOpenItems(group))
    await putPgProjectionValue(client, scope, MODEL_OPEN, group.inboxId, "", revision, group);
  else await deletePgProjectionValue(client, scope, MODEL_OPEN, group.inboxId, "");
}

async function inboxModelCurrent(client: PoolClient, scope: PgProjectionScope): Promise<boolean> {
  const meta = await client.query<{ runtime_inbox_version: number }>(
    `SELECT runtime_inbox_version FROM ha_projection_meta
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  return (meta.rows[0]?.runtime_inbox_version ?? RUNTIME_INBOX_MODEL_VERSION) === RUNTIME_INBOX_MODEL_VERSION;
}

/** Refold historical `runtime_inbox_*` events when opening a PG projection written before this model existed. */
export async function backfillPgRuntimeInbox(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
): Promise<number> {
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
    "SELECT event_json, readers FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 ORDER BY revision",
    keys,
  );
  let folded = 0;
  for (const row of events.rows) {
    const event = JSON.parse(row.event_json) as { readonly schema: string; readonly type: string };
    if (!isRuntimeInboxInput(event)) continue;
    await projectPgRuntimeInbox(client, { ...scope, readers: row.readers }, event);
    folded += 1;
  }
  await client.query(
    `UPDATE ha_projection_meta SET runtime_inbox_version=$4
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, RUNTIME_INBOX_MODEL_VERSION],
  );
  return folded;
}

export interface PgRuntimeInboxQueries {
  readonly readRuntimeInbox: (query: RuntimeInboxQuery) => Promise<RuntimeInboxRead>;
}

export function pgRuntimeInboxQueries(options: {
  readonly pool: Pool;
  readonly scope: PostgresScopeClaims & { readonly readers?: readonly string[] };
  readonly repoId: string;
}): PgRuntimeInboxQueries {
  const scope = options.scope,
    readers = [...(scope.readers ?? [])];
  return {
    readRuntimeInbox: (query) =>
      withPostgresTransaction(
        options.pool,
        async (client) => {
          const cut = await readCutInTransaction(client, scope, readers, options.repoId);
          if (cut.status !== "ready" || !(await inboxModelCurrent(client, scope)))
            return { status: "pending", watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          const base = { status: "ready" as const, watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          if (query.by === "inbox") {
            const group = await getPgProjectionValue<RuntimeInboxGroup>(client, scope, MODEL_GROUP, query.inboxId);
            return { ...base, rows: group ? [group] : [], nextCursor: null };
          }
          const limit = Math.min(
              Math.max(1, Math.trunc(query.limit ?? RUNTIME_INBOX_PAGE_LIMIT)),
              RUNTIME_INBOX_PAGE_LIMIT,
            ),
            values: unknown[] = [scope.tenantId, scope.projectId, scope.policyEpoch, readers],
            predicates = [
              "tenant_id=$1",
              "project_id=$2",
              "policy_epoch=$3",
              `model='${MODEL_OPEN}'`,
              "(cardinality($4::text[])=0 OR readers && $4::text[])",
            ];
          if (query.cursor !== undefined) {
            values.push(query.cursor);
            predicates.push(`entity_id COLLATE "C">$${values.length}`);
          }
          values.push(limit + 1);
          const groups = (
              await client.query<{ value: string }>(
                `SELECT value FROM ha_projection_values WHERE ${predicates.join(" AND ")}
                 ORDER BY entity_id COLLATE "C" LIMIT $${values.length}`,
                values,
              )
            ).rows.map(({ value }) => JSON.parse(value) as RuntimeInboxGroup),
            page = groups.slice(0, limit);
          return {
            ...base,
            rows: page,
            nextCursor: groups.length > limit ? page.at(-1)!.inboxId : null,
          };
        },
        scope,
        { isolationLevel: "repeatable read" },
      ),
  };
}
