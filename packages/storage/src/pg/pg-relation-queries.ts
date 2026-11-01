import { relationProjectionRowFromWitnesses } from "../projection/relation-entity-projection.ts";
import type { RelationEntity } from "@harness-anything/kernel/internal/domain/relation-event.ts";
import type { EntityVersionWitness } from "@harness-anything/kernel/internal/domain/entity-freshness.ts";
import type { TaskLifecycleSnapshot } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { parseEntityRef } from "@harness-anything/kernel/internal/domain/entity-ref.ts";
import type { TaskRelationProjectionRow } from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import type { PostgresScopeClaims } from "../postgres/transaction.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { checkedPageLimit } from "./pg-query-page.ts";
export async function readEntityVersionWitnesses(
  client: import("pg").PoolClient,
  claims: PostgresScopeClaims,
  readers: readonly string[],
  refs: readonly string[],
): Promise<ReadonlyMap<string, EntityVersionWitness>> {
  const result = new Map<string, EntityVersionWitness>();
  for (const ref of refs) {
    const parsed = parseEntityRef(ref);
    if (parsed === null || parsed.externalHarness) {
      result.set(ref, { entityRef: ref, freshness: "unknown", currentVersion: null });
      continue;
    }
    const { kind, id } = parsed;
    if (kind === "execution") {
      const executions = await client.query<{ source_version: string }>(
        `SELECT value->>'sourceObservedVersion' AS source_version FROM ha_relations
         WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND source_ref=$4 AND relation_type='executes'
           AND value ? 'sourceObservedVersion'
           AND (cardinality($5::text[])=0 OR readers && $5::text[])
         ORDER BY (value->>'sourceObservedVersion')::bigint DESC LIMIT 1`,
        [claims.tenantId, claims.projectId, claims.policyEpoch, ref, readers],
      );
      result.set(
        ref,
        executions.rows.length === 0
          ? { entityRef: ref, freshness: "unknown", currentVersion: null }
          : {
              entityRef: ref,
              freshness: "current",
              currentVersion: Number(executions.rows[0]!.source_version),
            },
      );
      continue;
    }
    const table =
      kind === "task"
        ? "ha_task_snapshots"
        : kind === "decision"
          ? "ha_decisions"
          : kind === "fact"
            ? "ha_facts"
            : kind === "agent"
              ? "ha_agents"
              : kind === "squad"
                ? "ha_squads"
                : null;
    const idColumn =
      kind === "task"
        ? "task_id"
        : kind === "decision"
          ? "decision_id"
          : kind === "fact"
            ? "fact_id"
            : kind === "agent"
              ? "agent_id"
              : kind === "squad"
                ? "squad_id"
                : null;
    if (!table || !idColumn) {
      result.set(ref, { entityRef: ref, freshness: "unknown", currentVersion: null });
      continue;
    }
    const row = await client.query<{
      workspace_revision: string;
      value?: Record<string, unknown>;
      snapshot?: TaskLifecycleSnapshot;
    }>(
      `SELECT workspace_revision::text, ${kind === "decision" || kind === "fact" ? "value" : kind === "task" ? "snapshot" : "declaration AS value"} FROM ${table} WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND ${idColumn}=$4 AND (cardinality($5::text[])=0 OR readers && $5::text[])`,
      [claims.tenantId, claims.projectId, claims.policyEpoch, id, readers],
    );
    if (!row.rows[0]) result.set(ref, { entityRef: ref, freshness: "unknown", currentVersion: null });
    else {
      const value = row.rows[0].value;
      result.set(ref, {
        entityRef: ref,
        freshness: "current",
        currentVersion: Number(row.rows[0].workspace_revision),
        ...(kind === "decision" && value?.state ? { state: String(value.state) } : {}),
      });
    }
  }
  return result;
}

export interface PgRelationQuery {
  readonly source?: string;
  readonly taskOwned?: boolean;
  readonly target?: string;
  readonly targets?: readonly string[];
  readonly sources?: readonly string[];
  readonly relationId?: string;
  readonly entity?: string;
  readonly state?: string;
  readonly direction?: string;
  readonly ownerRef?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly afterRelationId?: string;
  readonly relationType?: string;
  readonly limit?: number;
}

export async function readRelationsInTransaction(
  client: import("pg").PoolClient,
  claims: PgProjectionScope,
  readers: readonly string[],
  query: PgRelationQuery,
): Promise<readonly TaskRelationProjectionRow[]> {
  const values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
    where = [
      "tenant_id = $1",
      "project_id = $2",
      "policy_epoch = $3",
      "(cardinality($4::text[]) = 0 OR readers && $4::text[])",
    ];
  if (query.taskOwned === true) where.push("starts_with(source_ref, 'task/')");
  if (query.source !== undefined) {
    values.push(query.source);
    where.push(`source_ref = $${values.length}`);
  }
  if (query.targets !== undefined) {
    values.push(query.targets);
    where.push(`target_ref = ANY($${values.length}::text[])`);
  }
  if (query.target !== undefined) {
    values.push(query.target);
    where.push(`target_ref = $${values.length}`);
  }
  if (query.relationType !== undefined) {
    values.push(query.relationType);
    where.push(`relation_type = $${values.length}`);
  }
  if (query.sources !== undefined) {
    values.push(query.sources);
    where.push(`source_ref = ANY($${values.length}::text[])`);
  }
  if (query.entity !== undefined) {
    values.push(query.entity);
    where.push(`(source_ref=$${values.length} OR target_ref=$${values.length})`);
  }
  for (const [value, expression, comparison] of [
    [query.relationId, "relation_id", "="],
    [query.state, "relation_state", "="],
    [query.direction, "value->>'direction'", "="],
    [
      query.ownerRef,
      "CASE WHEN starts_with(source_ref, 'decision/') THEN split_part(source_ref, '/', 1) || '/' || split_part(source_ref, '/', 2) ELSE source_ref END",
      "=",
    ],
    [query.updatedAfter, "updated_at", ">="],
    [query.updatedBefore, "updated_at", "<="],
    [query.afterRelationId, "relation_id", ">"],
  ] as const)
    if (value !== undefined) {
      values.push(value);
      where.push(`${expression} ${comparison} $${values.length}`);
    }
  if (query.limit !== undefined) values.push(checkedPageLimit(query.limit, 4096));
  const result = await client.query<{
    relation_id: string;
    source_ref: string;
    target_ref: string;
    relation_type: string;
    relation_state: string;
    workspace_revision: string;
    value: Record<string, unknown>;
  }>(
    `SELECT relation_id, source_ref, target_ref, relation_type, relation_state, workspace_revision::text, value
           FROM ha_relations WHERE ${where.join(" AND ")} ORDER BY relation_id${query.limit === undefined ? "" : ` LIMIT $${values.length}`}`,
    values,
  );
  const refs = [...new Set(result.rows.flatMap((row) => [row.source_ref, row.target_ref]))],
    witnesses = await readEntityVersionWitnesses(client, claims, readers, refs);
  return result.rows.map((row) => {
    const {
      sourcePath: _sourcePath,
      recordIndex: _recordIndex,
      sourceObservedVersion: _sourceObservedVersion,
      ...value
    } = row.value;
    const entity = value as unknown as RelationEntity;
    const projected = relationProjectionRowFromWitnesses(
      entity,
      String(row.value.sourcePath),
      witnesses.get(row.target_ref)!,
      witnesses.get(row.source_ref)!,
    );
    const { schema: _schema, entity: _entity, ...taskRow } = projected;
    return taskRow;
  });
}
