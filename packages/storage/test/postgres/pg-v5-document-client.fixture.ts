// Previous binary's SQL/guard, frozen from 1482630f0 via tools/readonly-checkout.mjs.
// Intentionally does not import current projection values or the current generation constant.
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { canonicalJson } from "../../src/projection/rebuildable-task-projection-sql.ts";
import type { PgProjectionScope } from "../../src/pg/pg-task-event-materialize.ts";

export async function v5Documents(client: PoolClient, scope: PgProjectionScope) {
  const parameters = [scope.tenantId, scope.projectId, scope.policyEpoch],
    version = await client.query<{ schema_version: number }>(
      "SELECT schema_version FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
      parameters,
    );
  assert.equal(version.rows[0]?.schema_version, 5, "previous binary must still admit this generation");
  const result = await client.query<{ value: string }>(
    `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='document'
     AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY entity_id,owner_id`,
    [...parameters, [...(scope.readers ?? [])]],
  );
  return result.rows.map(({ value }) => JSON.parse(value) as { path: string; body: string });
}

export async function v5PutDocument(
  client: PoolClient,
  scope: PgProjectionScope,
  document: { readonly path: string; readonly workspaceRevision: number },
) {
  await v5Documents(client, scope);
  await client.query(
    `INSERT INTO ha_projection_values
    (tenant_id,project_id,policy_epoch,readers,model,entity_id,owner_id,workspace_revision,value)
    VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8,$9)
    ON CONFLICT (tenant_id,project_id,policy_epoch,model,owner_id,entity_id) DO UPDATE SET
      readers=excluded.readers, workspace_revision=excluded.workspace_revision, value=excluded.value
    WHERE ha_projection_values.workspace_revision <= excluded.workspace_revision`,
    [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      [...(scope.readers ?? [])],
      "document",
      document.path,
      "",
      document.workspaceRevision,
      canonicalJson(document),
    ],
  );
}
