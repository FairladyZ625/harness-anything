import type { PoolClient } from "pg";
import { canonicalizeWriteValue } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import { POSTGRES_SCOPE_COLUMNS_SQL } from "../postgres/scope-schema.ts";
import { reduceEntityDeclarationState } from "../store/entity-declaration-state.ts";
import type {
  EntityDeclarationState,
  EntityDeclarationReadQuery,
} from "@harness-anything/kernel/internal/ports/entity-declarations.ts";
import { type StoredEntityEventV1 } from "@harness-anything/kernel/internal/domain/entity-event.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

export const entityDeclarationDdl = [
  /* @gate-identity state-store/task.projection.ha_entity_declaration_heads */ `CREATE TABLE IF NOT EXISTS ha_entity_declaration_heads (
    ${POSTGRES_SCOPE_COLUMNS_SQL}, readers text[] NOT NULL DEFAULT '{}',
    entity_kind text NOT NULL, entity_id text NOT NULL, state text NOT NULL,
    live boolean NOT NULL, workspace_revision bigint NOT NULL,
    PRIMARY KEY (tenant_id,project_id,policy_epoch,entity_kind,entity_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ha_entity_declaration_live ON ha_entity_declaration_heads
    (tenant_id,project_id,policy_epoch,entity_kind,entity_id) WHERE live`,
  `ALTER TABLE ha_projection_meta ADD COLUMN IF NOT EXISTS entity_declaration_watermark bigint NOT NULL DEFAULT 0`,
] as const;

export async function materializePgEntityDeclaration(
  client: PoolClient,
  scope: PgProjectionScope,
  event: StoredEntityEventV1,
): Promise<void> {
  const meta = (
      await client.query<{ watermark: string; entity_declaration_watermark: string }>(
        "SELECT watermark,entity_declaration_watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      )
    ).rows[0],
    prefix = Number(meta?.entity_declaration_watermark ?? 0);
  // During expansion, only ordered backfill owns the new model. Live writes must not overwrite its prefix.
  if (prefix !== event.workspaceRevision - 1 || prefix < Number(meta?.watermark ?? 0)) return;
  await reduceAndStoreDeclaration(client, scope, event);
}

export async function reduceAndStoreDeclaration(
  client: PoolClient,
  scope: PgProjectionScope,
  event: StoredEntityEventV1,
): Promise<void> {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch, event.payload.entityKind, event.payload.entityId],
    before = (
      await client.query<{ state: string }>(
        `SELECT state FROM ha_entity_declaration_heads
      WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND entity_kind=$4 AND entity_id=$5`,
        keys,
      )
    ).rows[0],
    state = reduceEntityDeclarationState(before ? (JSON.parse(before.state) as EntityDeclarationState) : null, event);
  await client.query(
    `INSERT INTO ha_entity_declaration_heads
    (tenant_id,project_id,policy_epoch,entity_kind,entity_id,state,live,workspace_revision,readers)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,project_id,policy_epoch,entity_kind,entity_id)
    DO UPDATE SET state=excluded.state,live=excluded.live,workspace_revision=excluded.workspace_revision,readers=excluded.readers`,
    [
      ...keys,
      JSON.stringify(canonicalizeWriteValue(state)),
      state.declaration !== null,
      event.workspaceRevision,
      scope.readers ?? [],
    ],
  );
}

export async function readPgEntityDeclarations(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
  query: EntityDeclarationReadQuery,
): Promise<readonly EntityDeclarationState[]> {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    readiness = (
      await client.query<{ ready: boolean }>(
        `SELECT COALESCE(m.entity_declaration_watermark,0)=h.revision AS ready
      FROM ha_repo_heads h LEFT JOIN ha_projection_meta m ON m.tenant_id=h.tenant_id AND m.project_id=h.project_id
      AND m.policy_epoch=h.policy_epoch AND m.projection_name='task/v1'
      WHERE h.tenant_id=$1 AND h.project_id=$2 AND h.policy_epoch=$3 AND h.repo_id=$4`,
        [...keys, repoId],
      )
    ).rows[0];
  if (readiness && !readiness.ready)
    throw Object.assign(new Error("Current declaration index needs projection rebuild"), {
      code: "projection_pending",
    });
  const values: unknown[] = [...keys, query.kind, scope.readers ?? []],
    conditions = [
      "tenant_id=$1",
      "project_id=$2",
      "policy_epoch=$3",
      "entity_kind=$4",
      "live",
      "(cardinality($5::text[])=0 OR readers && $5::text[])",
    ];
  if (query.id !== undefined) {
    values.push(query.id);
    conditions.push(`entity_id=$${values.length}`);
  }
  let pageSql = "";
  if (query.limit !== undefined) {
    values.push(query.limit);
    pageSql = ` LIMIT $${values.length}`;
  }
  return (
    await client.query<{ state: string }>(
      `SELECT state FROM ha_entity_declaration_heads WHERE ${conditions.join(" AND ")} ORDER BY entity_id${pageSql}`,
      values,
    )
  ).rows.map((row) => JSON.parse(row.state) as EntityDeclarationState);
}
