import type { PoolClient } from "pg";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT, postgresScopeRlsStatements } from "../postgres/scope-schema.ts";
import type { EntityProjectionRow, VersionedRelationProjectionRow } from "@harness-anything/kernel";
import { getPgProjectionValue } from "./pg-projection-values.ts";
import { relationProjectionRowFromColumns } from "../projection/relation-entity-projection.ts";
import { isRelationFreshness } from "../projection/relation-freshness-columns.ts";
import type { RelationEntity } from "@harness-anything/kernel/internal/domain/relation-event.ts";
import type {
  EntityVersion,
  EntityVersionWitness,
  RelationFreshness,
} from "@harness-anything/kernel/internal/domain/entity-freshness.ts";
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
    if (ref === `${kind}/${id}`) {
      const projected = await getPgProjectionValue<EntityProjectionRow>(
        client,
        { ...claims, readers },
        `entity:${kind}`,
        id,
        null,
      );
      if (projected) {
        result.set(ref, { entityRef: ref, freshness: projected.freshness, currentVersion: projected.currentVersion });
        continue;
      }
    }
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
      kind === "relation"
        ? "ha_relations"
        : kind === "task"
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
      kind === "relation"
        ? "relation_id"
        : kind === "task"
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
      `SELECT workspace_revision::text, ${kind === "decision" || kind === "fact" || kind === "relation" ? "value" : kind === "task" ? "snapshot" : "declaration AS value"} FROM ${table} WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND ${idColumn}=$4 AND (cardinality($5::text[])=0 OR readers && $5::text[])`,
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
  readonly excludeFactOwned?: boolean;
  readonly targetRoot?: string;
  /** Restrict sources to one entity-kind prefix, e.g. `decision/` for task snapshot lineage. */
  readonly sourceRoot?: string;
  readonly taskOwned?: boolean;
  readonly target?: string;
  readonly targets?: readonly string[];
  readonly sources?: readonly string[];
  readonly relationId?: string;
  readonly relationIds?: readonly string[];
  readonly entity?: string;
  readonly state?: string;
  readonly direction?: string;
  readonly ownerRef?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly afterRelationId?: string;
  readonly relationType?: string;
  readonly freshness?: RelationFreshness;
  readonly limit?: number;
}

export async function readVersionedRelationsInTransaction(
  client: import("pg").PoolClient,
  claims: PgProjectionScope,
  readers: readonly string[],
  query: PgRelationQuery,
): Promise<readonly VersionedRelationProjectionRow[]> {
  if (query.targets?.length === 0 || query.sources?.length === 0 || query.relationIds?.length === 0) return [];
  if (
    readers.length &&
    query.limit !== undefined &&
    query.source === undefined &&
    query.target === undefined &&
    query.sources === undefined &&
    query.targets === undefined &&
    query.sourceRoot === undefined &&
    query.targetRoot === undefined &&
    !query.taskOwned &&
    !query.excludeFactOwned &&
    query.relationId === undefined &&
    query.relationIds === undefined &&
    query.ownerRef === undefined &&
    query.entity === undefined &&
    query.direction === undefined &&
    query.freshness === undefined &&
    query.updatedAfter === undefined &&
    query.updatedBefore === undefined
  ) {
    const ids = await readReaderRelationPage(client, claims, readers, query);
    if (ids !== null)
      return readVersionedRelationsInTransaction(client, claims, readers, {
        ...query,
        limit: undefined,
        relationIds: ids,
      });
  }
  const values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
    where = [
      "tenant_id = $1",
      "project_id = $2",
      "policy_epoch = $3",
      "(cardinality($4::text[]) = 0 OR readers && $4::text[])",
    ];
  // OFFSET 0 keeps each explicit input key as the parameterized index driver. A
  // flattened ANY/join can otherwise scan the entire relation history at fixed k.
  const batch = query.targets ?? query.sources ?? query.relationIds;
  const batchColumn =
    query.targets !== undefined ? "target_ref" : query.sources !== undefined ? "source_ref" : "relation_id";
  if (batch !== undefined) values.push([...new Set(batch)]);
  const batchParameter = values.length;
  if (query.excludeFactOwned) where.push(`(source_ref COLLATE "C" < 'fact/' OR source_ref COLLATE "C" >= 'fact0')`);
  if (query.sourceRoot !== undefined) {
    values.push(query.sourceRoot);
    where.push(`starts_with(source_ref, $${values.length})`);
    if (query.sourceRoot.endsWith("/")) {
      values.push(`${query.sourceRoot.slice(0, -1)}0`);
      where.push(`source_ref COLLATE "C" >= $${values.length - 1} AND source_ref COLLATE "C" < $${values.length}`);
    }
  }
  if (query.targetRoot !== undefined) {
    values.push(query.targetRoot, `${query.targetRoot}/`, `${query.targetRoot}0`);
    where.push(
      `(target_ref=$${values.length - 2} OR (target_ref COLLATE "C" >= $${values.length - 1} AND target_ref COLLATE "C" < $${values.length}))`,
    );
  }
  if (query.taskOwned === true) where.push(`source_ref COLLATE "C" >= 'task/' AND source_ref COLLATE "C" < 'task0'`);
  if (query.source !== undefined) {
    values.push(query.source);
    where.push(`source_ref = $${values.length}`);
  }
  // The driver supplies one column predicate; shared arrays still represent independent filters.
  if (query.targets !== undefined && batchColumn !== "target_ref") {
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
  if (query.relationIds !== undefined && batchColumn !== "relation_id") {
    values.push(query.relationIds);
    where.push(`relation_id=ANY($${values.length}::text[])`);
  }
  if (query.sources !== undefined && batchColumn !== "source_ref") {
    values.push(query.sources);
    where.push(`source_ref = ANY($${values.length}::text[])`);
  }
  if (query.entity !== undefined) {
    // Own edges plus sub-refs (`decision/<id>/<claim>`), matching the SQLite range predicate.
    values.push(query.entity, `${query.entity}/`, `${query.entity}0`);
    const entity = values.length - 2,
      lower = values.length - 1,
      upper = values.length;
    where.push(
      `(source_ref=$${entity} OR target_ref=$${entity} OR (source_ref COLLATE "C" >= $${lower} AND source_ref COLLATE "C" < $${upper}) OR (target_ref COLLATE "C" >= $${lower} AND target_ref COLLATE "C" < $${upper}))`,
    );
  }
  if (query.ownerRef !== undefined) {
    // A decision anchor's owner is its root, never the anchor itself.
    if (query.ownerRef.startsWith("decision/") && !/^decision\/[^/]+$/u.test(query.ownerRef)) return [];
    values.push(query.ownerRef);
    if (/^decision\/[^/]+$/u.test(query.ownerRef)) {
      values.push(`${query.ownerRef}/`, `${query.ownerRef}0`);
      where.push(
        `(source_ref=$${values.length - 2} OR (source_ref COLLATE "C" >= $${values.length - 1} AND source_ref COLLATE "C" < $${values.length}))`,
      );
    } else {
      where.push(`source_ref=$${values.length}`);
    }
  }
  for (const [value, expression, comparison] of [
    [query.relationId, "relation_id", "="],
    [query.state, "relation_state", "="],
    [query.direction, "value->>'direction'", "="],
    [query.updatedAfter, "updated_at", ">="],
    [query.updatedBefore, "updated_at", "<="],
    [query.afterRelationId, "relation_id", ">"],
  ] as const)
    if (value !== undefined) {
      values.push(value);
      where.push(`${expression} ${comparison} $${values.length}`);
    }
  // dec_E34C4284B48AFAF152D7BF1980: freshness is stored at the write cut, so a visible relation
  // returns that one global value and a freshness filter is an indexed column predicate.
  if (query.freshness !== undefined) {
    values.push(query.freshness);
    where.push(`freshness = $${values.length}`);
  }
  if (query.limit !== undefined) values.push(checkedPageLimit(query.limit, 4096));
  const predicate = where.join(" AND "),
    from =
      batch === undefined
        ? `ha_relations WHERE ${predicate}`
        : `unnest($${batchParameter}::text[]) AS endpoint(ref) CROSS JOIN LATERAL (
        SELECT * FROM ha_relations WHERE ${predicate} AND ${batchColumn}=endpoint.ref OFFSET 0) AS relation`;
  const result = await client.query<SelectedRelationRow & { freshness: string | null }>(
    `SELECT ${selectedRelationColumns}, freshness, current_target_version
           FROM ${from} ORDER BY relation_id${query.limit === undefined ? "" : ` LIMIT $${values.length}`}`,
    values,
  );
  return result.rows.map((row) => {
    // A row without stored freshness was written before the settle that precedes serving; fail closed.
    if (!isRelationFreshness(row.freshness)) throw new Error(`relation ${row.relation_id} has no stored freshness`);
    return relationProjectionRowFromColumns(relationEntity(row), String(row.value.sourcePath), {
      freshness: row.freshness,
      currentTargetVersion: row.current_target_version,
    });
  });
}

/** Per verified authorization key take at most k candidates, then deduplicate
 * and take the global k. Overlapping keys cannot skip a row or distort nextCursor.
 * The payload query still applies ha_relations' authoritative visibility predicate
 * in this repeatable-read cut; the expansion never becomes a second ACL policy.
 */
async function readReaderRelationPage(
  client: import("pg").PoolClient,
  scope: PgProjectionScope,
  readers: readonly string[],
  query: PgRelationQuery,
): Promise<readonly string[] | null> {
  const values: unknown[] = [scope.tenantId, scope.projectId, scope.policyEpoch, [...new Set(readers)]],
    pending = await client.query(
      `SELECT 1 FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      AND reader_index_version=0 LIMIT 1`,
      values.slice(0, 3),
    );
  // During the dated expansion, keep the previous reader available until the
  // scoped pending index is empty. A read never repairs or partially trusts keys.
  if (pending.rows.length) return null;
  const where = ["tenant_id=$1", "project_id=$2", "policy_epoch=$3", "reader_key=allowed.key"];
  for (const [value, column, op] of [
    [query.relationType, "relation_type", "="],
    [query.state, "relation_state", "="],
    [query.afterRelationId, "relation_id", ">"],
  ] as const)
    if (value !== undefined) {
      values.push(value);
      where.push(`${column}${op}$${values.length}`);
    }
  values.push(checkedPageLimit(query.limit!, 4096));
  const result = await client.query<{ relation_id: string }>(
    `SELECT DISTINCT relation_id FROM unnest($4::text[]) AS allowed(key) CROSS JOIN LATERAL (
      SELECT relation_id FROM ha_relation_reader_keys WHERE ${where.join(" AND ")}
      ORDER BY relation_id LIMIT $${values.length} OFFSET 0) AS candidate
      ORDER BY relation_id LIMIT $${values.length}`,
    values,
  );
  return result.rows.map(({ relation_id }) => relation_id);
}

interface SelectedRelationRow {
  relation_id: string;
  source_ref: string;
  target_ref: string;
  relation_type: string;
  relation_state: string;
  workspace_revision: string;
  value: Record<string, unknown>;
  current_target_version: EntityVersion | null;
}

const selectedRelationColumns =
  "relation_id, source_ref, target_ref, relation_type, relation_state, workspace_revision::text, value";

function relationEntity(row: SelectedRelationRow): RelationEntity {
  const {
    sourcePath: _sourcePath,
    recordIndex: _recordIndex,
    sourceObservedVersion: _sourceObservedVersion,
    ...value
  } = row.value;
  return value as unknown as RelationEntity;
}

export async function readRelationsInTransaction(
  client: import("pg").PoolClient,
  scope: PgProjectionScope,
  readers: readonly string[],
  query: PgRelationQuery,
): Promise<readonly TaskRelationProjectionRow[]> {
  return (await readVersionedRelationsInTransaction(client, scope, readers, query)).map(
    ({ schema: _schema, entity: _entity, ...row }) => row,
  );
}

/** Additive v5 expansion. The existing relation remains the only payload and ACL
 * authority. Triggers maintain the ordered multi-value index for current and
 * previous writers. Contract the backfill/version column after 2026-11-28 once
 * the previous-writer window and all scoped backfills have completed.
 */
export function relationReaderIndexDdl(): readonly string[] {
  return [
    /* @gate-identity state-store/task.projection.ha_relation_reader_keys */ `CREATE TABLE IF NOT EXISTS ha_relation_reader_keys (
      tenant_id text NOT NULL, project_id text NOT NULL, policy_epoch bigint NOT NULL,
      readers text[] NOT NULL DEFAULT '{}', reader_key text NOT NULL, relation_id text NOT NULL,
      relation_type text NOT NULL, relation_state text NOT NULL,
      PRIMARY KEY(tenant_id,project_id,policy_epoch,reader_key,relation_id)
    )`,
    // The previous runtime can fire the trigger as soon as it is installed. Give
    // its writes scoped access first, without a schema-owner/SECURITY DEFINER path.
    ...postgresScopeRlsStatements("ha_relation_reader_keys", { ifNotExists: true }),
    ...[POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime, POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.migration].map(
      (role) => `DO $grant$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
        GRANT SELECT,INSERT,UPDATE,DELETE ON ha_relation_reader_keys TO "${role}";
      END IF; END $grant$`,
    ),
    // All four type/state filter shapes retain relation_id order inside one reader key.
    ...["relation_type", "relation_state", "relation_type,relation_state"].map(
      (columns, index) =>
        `CREATE INDEX IF NOT EXISTS ha_relation_reader_keys_page_${index} ON ha_relation_reader_keys
        (tenant_id,project_id,policy_epoch,reader_key,${columns},relation_id)`,
    ),
    "ALTER TABLE ha_relations ADD COLUMN IF NOT EXISTS reader_index_version smallint NOT NULL DEFAULT 0",
    `CREATE INDEX IF NOT EXISTS ha_relations_reader_index_pending ON ha_relations
      (tenant_id,project_id,policy_epoch,relation_id) WHERE reader_index_version=0`,
    `CREATE OR REPLACE FUNCTION ha_relation_reader_index_sync() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF TG_OP<>'INSERT' THEN
          DELETE FROM ha_relation_reader_keys WHERE tenant_id=OLD.tenant_id AND project_id=OLD.project_id
            AND policy_epoch=OLD.policy_epoch AND reader_key=ANY(OLD.readers) AND relation_id=OLD.relation_id;
        END IF;
        IF TG_OP<>'DELETE' THEN
          INSERT INTO ha_relation_reader_keys(tenant_id,project_id,policy_epoch,readers,reader_key,relation_id,relation_type,relation_state)
          SELECT NEW.tenant_id,NEW.project_id,NEW.policy_epoch,ARRAY[key],key,NEW.relation_id,NEW.relation_type,NEW.relation_state
          FROM (SELECT DISTINCT unnest(NEW.readers) AS key) keys;
          RETURN NEW;
        END IF;
        RETURN OLD;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_relation_reader_index_sync AFTER INSERT OR UPDATE OF readers,relation_type,relation_state,relation_id,tenant_id,project_id,policy_epoch
      OR DELETE ON ha_relations FOR EACH ROW EXECUTE FUNCTION ha_relation_reader_index_sync()`,
    // Certify readiness only after the maintaining trigger exists. A previous
    // writer between DDL statements may leave a conservative pending row, never
    // a ready row without keys. Both triggers then share the relation transaction.
    `CREATE OR REPLACE FUNCTION ha_relation_reader_index_mark() RETURNS trigger
      LANGUAGE plpgsql AS $function$ BEGIN NEW.reader_index_version:=1; RETURN NEW; END $function$`,
    `CREATE OR REPLACE TRIGGER ha_relation_reader_index_mark BEFORE INSERT OR UPDATE OF readers,relation_type,relation_state,relation_id,tenant_id,project_id,policy_epoch
      ON ha_relations FOR EACH ROW EXECUTE FUNCTION ha_relation_reader_index_mark()`,
  ];
}

/** A management call, never a lazy reader repair. Each transaction fills at most
 * 64 rows through the same previous-writer trigger. processed=0 ends the drain;
 * the pending partial index is the monotonic remainder across committed pages.
 */
export async function backfillPgRelationReaderIndexPage(client: PoolClient, scope: PgProjectionScope): Promise<number> {
  const result = await client.query<{ processed: number }>(
    `WITH batch AS (SELECT relation_id FROM ha_relations
      WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_index_version=0
      ORDER BY relation_id LIMIT 64 FOR UPDATE), filled AS (
      UPDATE ha_relations r SET readers=r.readers FROM batch b
      WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.policy_epoch=$3 AND r.relation_id=b.relation_id RETURNING 1)
      SELECT count(*)::integer AS processed FROM filled`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  return result.rows[0]!.processed;
}
