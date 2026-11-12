import type { PoolClient } from "pg";
import { assertPgReadIndexReady, pgRuntimeObservedAtSql } from "./pg-read-index-migration.ts";
import { assertPgEventReadIndexReady } from "./pg-event-read-index-migration.ts";
import type { RuntimeSession, RuntimeSessionReadQuery } from "@harness-anything/kernel";
import { runtimeSessionInActivityWindow } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { canonicalJson } from "../projection/rebuildable-task-projection-sql.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

/**
 * Named read models share the projection lifecycle, transaction, scope and revision fence.
 * Serialized JSON is text: JSONB cannot represent the NUL characters legal in document bodies.
 * Decode in this adapter, without passing the stored text through PostgreSQL JSON processing.
 */
export async function putPgProjectionValue(
  client: PoolClient,
  scope: PgProjectionScope,
  model: string,
  id: string,
  owner: string,
  revision: number,
  value: unknown,
): Promise<void> {
  let documentMetadata: string | null = null;
  if (model === "document") {
    const { body: _body, ...metadata } =
      value as import("@harness-anything/kernel/internal/domain/doc-sync.contract.ts").DocumentState;
    documentMetadata = canonicalJson(metadata);
  }
  await client.query(
    `INSERT INTO ha_projection_values
    (tenant_id,project_id,policy_epoch,readers,model,entity_id,owner_id,workspace_revision,value,document_metadata)
    VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10)
    ON CONFLICT (tenant_id,project_id,policy_epoch,model,owner_id,entity_id) DO UPDATE SET
      readers=excluded.readers, workspace_revision=excluded.workspace_revision, value=excluded.value,
      document_metadata=excluded.document_metadata
    WHERE ha_projection_values.workspace_revision <= excluded.workspace_revision`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      model,
      id,
      owner,
      revision,
      canonicalJson(value),
      documentMetadata,
    ],
  );
}
export async function deletePgProjectionValue(
  client: PoolClient,
  scope: PgProjectionScope,
  model: string,
  id: string,
  owner = "",
): Promise<void> {
  await client.query(
    "DELETE FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model=$4 AND entity_id=$5 AND owner_id=$6",
    [scope.tenantId, scope.projectId, scope.policyEpoch, model, id, owner],
  );
}
export async function listPgProjectionValues<Value>(
  client: PoolClient,
  scope: PgProjectionScope,
  model: string,
  owner?: string,
): Promise<readonly Value[]> {
  const result = await client.query<{ value: string }>(
    `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model=$4
     AND (cardinality($5::text[])=0 OR readers && $5::text[])${owner === undefined ? "" : " AND owner_id=$6"} ORDER BY entity_id,owner_id`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      model,
      [...(scope.readers ?? [])],
      ...(owner === undefined ? [] : [owner]),
    ],
  );
  return result.rows.map(({ value }) => JSON.parse(value) as Value);
}
export async function getPgProjectionValue<Value>(
  client: PoolClient,
  scope: PgProjectionScope,
  model: string,
  id: string,
  owner: string | null = "",
): Promise<Value | null> {
  const result = await client.query<{ value: string }>(
    `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model=$4 AND entity_id=$5 AND ($6::text IS NULL OR owner_id=$6)
     AND (cardinality($7::text[])=0 OR readers && $7::text[]) ORDER BY owner_id DESC LIMIT 1`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, model, id, owner, [...(scope.readers ?? [])]],
  );
  return result.rows[0] ? (JSON.parse(result.rows[0].value) as Value) : null;
}

/**
 * Outcome is a materialized scalar: a JSONB cast cannot cross runtime RLS safely or represent
 * every accepted opaque provider id. Keep the model literal so its partial index is provable.
 */
export function pgRuntimeSessionReadStatement(
  scope: PgProjectionScope,
  repoId: string,
  query: RuntimeSessionReadQuery = {},
): { readonly text: string; readonly values: readonly unknown[] } {
  const values: unknown[] = [scope.tenantId, scope.projectId, scope.policyEpoch, [...(scope.readers ?? [])]];
  if (query.inFlightOnly)
    // Current-set projection maintained by the same write transaction: sized by what is running
    // now, never by the settled sessions' index entries.
    return {
      text: `SELECT v.value FROM ha_runtime_unsettled v
        WHERE v.tenant_id=$1 AND v.project_id=$2 AND v.policy_epoch=$3
          AND (cardinality($4::text[])=0 OR v.readers && $4::text[])
        ORDER BY v.entity_id`,
      values,
    };
  const where = [
      "v.tenant_id=$1",
      "v.project_id=$2",
      "v.policy_epoch=$3",
      "v.model='runtime-session'",
      "v.owner_id=''",
      "(cardinality($4::text[])=0 OR v.readers && $4::text[])",
    ],
    bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
  const sessionParameter = query.runtimeSessionId === undefined ? undefined : bind(query.runtimeSessionId);
  if (sessionParameter) where.push(`v.entity_id=${sessionParameter}`);
  if (query.unsettledOnly) where.push("v.runtime_outcome IS NULL");
  if (query.nonExitedOnly)
    where.push(`EXISTS (SELECT 1 FROM ha_projection_values active
    JOIN ha_projection_values address ON address.tenant_id=active.tenant_id AND address.project_id=active.project_id
      AND address.policy_epoch=active.policy_epoch AND address.model='dispatch-lifecycle-session' AND address.owner_id=''
      AND address.value=to_jsonb(active.entity_id)::text
    WHERE active.tenant_id=v.tenant_id AND active.project_id=v.project_id AND active.policy_epoch=v.policy_epoch
      AND active.model='dispatch-lifecycle-active' AND address.entity_id=v.entity_id
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(ha_read_index_json(active.value)->'attempts') attempt
        WHERE attempt->>'dispatchId'=ha_read_index_json(active.value)->>'currentDispatchId'
          AND attempt->>'runtimeSessionId'=v.entity_id)
      AND (cardinality($4::text[])=0 OR active.readers && $4::text[])
      AND (cardinality($4::text[])=0 OR address.readers && $4::text[]))`);
  if (query.providerSessionId !== undefined)
    where.push(`ha_read_index_json(v.value)->>'providerSessionId'=${bind(query.providerSessionId)}`);
  const observed = pgRuntimeObservedAtSql("v.value");
  for (const [boundary, operator] of [
    [query.observedAfter, ">="],
    [query.observedBefore, "<="],
  ] as const)
    if (boundary !== undefined)
      where.push(`${observed}${operator}${bind(new Date(boundary).toISOString().slice(0, -1))}`);
  if (query.executionOwnerNodeId !== undefined) {
    const repoParameter = bind(repoId),
      nodeParameter = bind(query.executionOwnerNodeId);
    const candidate = (after: boolean) => `SELECT e.runtime_session_id COLLATE "default" AS runtime_session_id
      FROM ha_events e WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.policy_epoch=$3 AND e.repo_id=${repoParameter}
      AND e.event_schema='agent-runtime-event/v1' AND e.event_type='runtime_dispatch_requested'
      AND e.source_node_id=${nodeParameter} AND e.runtime_session_present${query.unsettledOnly ? " AND e.runtime_session_unsettled" : ""}
      AND (cardinality($4::text[])=0 OR e.readers && $4::text[])
      ${sessionParameter ? `AND e.runtime_session_id COLLATE "default"=${sessionParameter}` : ""}
      ${after ? 'AND e.runtime_session_id COLLATE "default">previous.runtime_session_id' : ""}
      ORDER BY e.runtime_session_id COLLATE "default" LIMIT 1`;
    return {
      text: `WITH RECURSIVE owned AS ((${candidate(false)}) UNION ALL
        SELECT next.* FROM owned previous CROSS JOIN LATERAL (${candidate(true)}) next)
        SELECT selected.value FROM owned CROSS JOIN LATERAL (
          SELECT v.value FROM ha_projection_values v WHERE ${where.join(" AND ")}
            AND v.entity_id=owned.runtime_session_id COLLATE "default" LIMIT 1
        ) selected ORDER BY owned.runtime_session_id`,
      values,
    };
  }
  if (query.activitySince !== undefined) {
    const since = bind(new Date(query.activitySince).toISOString().slice(0, -1)),
      selected = `SELECT v.entity_id,v.value FROM ha_projection_values v WHERE ${where.join(" AND ")}`;
    // Separate indexed arms keep old live sessions and recent closed sessions without walking
    // the settled history in id order. UNION removes sessions that satisfy both arms.
    return {
      text: `SELECT value FROM (${selected} AND v.runtime_liveness='live'
        UNION ${selected} AND ${observed}>=${since}) selected ORDER BY entity_id`,
      values,
    };
  }
  return {
    text: `SELECT v.value FROM ha_projection_values v WHERE ${where.join(" AND ")} ORDER BY v.entity_id, v.owner_id`,
    values,
  };
}

export async function listPgRuntimeSessions(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
  query: RuntimeSessionReadQuery = {},
): Promise<readonly RuntimeSession[]> {
  if (query.unsettledOnly || query.nonExitedOnly || query.activitySince !== undefined)
    await assertPgReadIndexReady(client, scope, "runtime-session");
  if (query.executionOwnerNodeId !== undefined) await assertPgEventReadIndexReady(client, scope, repoId);
  const statement = pgRuntimeSessionReadStatement(scope, repoId, query),
    result = await client.query<{ value: string }>(statement.text, [...statement.values]);
  // inFlightOnly uses the bounded current-set table; all other ranges are indexed in SQL.
  return result.rows
    .map(({ value }) => JSON.parse(value) as RuntimeSession)
    .filter(
      (session) =>
        (query.activitySince === undefined || runtimeSessionInActivityWindow(session, query.activitySince)) &&
        (query.observedAfter === undefined || Date.parse(session.lastObservedAt) >= Date.parse(query.observedAfter)) &&
        (query.observedBefore === undefined || Date.parse(session.lastObservedAt) <= Date.parse(query.observedBefore)),
    );
}
