import type { PoolClient } from "pg";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

/** Named read models share the projection lifecycle, transaction, scope and revision fence. */
export async function putPgProjectionValue(
  client: PoolClient,
  scope: PgProjectionScope,
  model: string,
  id: string,
  owner: string,
  revision: number,
  value: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO ha_projection_values
    (tenant_id,project_id,policy_epoch,readers,model,entity_id,owner_id,workspace_revision,value)
    VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8,$9::jsonb)
    ON CONFLICT (tenant_id,project_id,policy_epoch,model,owner_id,entity_id) DO UPDATE SET
      readers=excluded.readers, workspace_revision=excluded.workspace_revision, value=excluded.value
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
      JSON.stringify(value),
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
  const result = await client.query<{ value: Value }>(
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
  return result.rows.map(({ value }) => value);
}
export async function getPgProjectionValue<Value>(
  client: PoolClient,
  scope: PgProjectionScope,
  model: string,
  id: string,
  owner = "",
): Promise<Value | null> {
  const result = await client.query<{ value: Value }>(
    `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model=$4 AND entity_id=$5 AND owner_id=$6
     AND (cardinality($7::text[])=0 OR readers && $7::text[])`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, model, id, owner, [...(scope.readers ?? [])]],
  );
  return result.rows[0]?.value ?? null;
}
