import { PgRelationCycleWinners } from "./pg-relation-cycle-winners.ts";
import type { PoolClient } from "pg";
import {
  findRelationCycleWitnesses,
  type RelationCycleEdge,
} from "@harness-anything/kernel/internal/domain/relation-cycle.ts";
import { relationTypeDeclarations } from "@harness-anything/kernel/internal/domain/relation-type-registry.ts";
import type { RelationCycleAudit, RelationCycleIssue } from "@harness-anything/kernel";
import { checkedPageLimit } from "./pg-query-page.ts";
import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  dialectCreateTriggerStatements,
  dialectUpsertSelectSql,
  dialectUpsertValuesSql,
  getClientDialectCapabilities,
  type PgDialectCapabilities,
} from "../postgres/dialect.ts";
import { POSTGRES_SCOPE_COLUMNS_SQL } from "../postgres/scope-schema.ts";

export interface PgRelationCycleScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyEpoch: number;
  readonly readers?: readonly string[];
}

export interface PgRelationCycleRefreshPage {
  readonly processed: number;
  readonly done: boolean;
}

const acyclicTypes = relationTypeDeclarations.filter(({ acyclic }) => acyclic).map(({ type }) => type),
  acyclicSql = acyclicTypes.map((type) => `'${type}'`).join(","),
  relationCycleTables = [
    "ha_relation_cycle_edge",
    "ha_relation_cycle_count",
    "ha_relation_cycle_dirty",
    "ha_relation_cycle_component",
    "ha_relation_cycle_member",
    "ha_relation_cycle_result",
  ] as const;

export const PG_RELATION_CYCLE_TABLES = Object.freeze(relationCycleTables);

/** Relation writes mirror only cycle-relevant edges. The count row also owns the resumable backfill cursor. */
export function relationCycleAuditDdl(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  const dirtyMarkSql = dialectUpsertSelectSql(capabilities, {
      table: "ha_relation_cycle_dirty",
      columns: ["tenant_id", "project_id", "policy_epoch", "reader_key", "relation_type", "node_ref"],
      selectSql: `SELECT tenant AS tenant_id,project AS project_id,epoch AS policy_epoch,reader_key,kind AS relation_type,node AS node_ref FROM ha_relation_cycle_count
          WHERE tenant_id=tenant AND project_id=project AND policy_epoch=epoch
            AND (cardinality(reader_key)=0 OR reader_key && visibility)`,
      conflictColumns: ["tenant_id", "project_id", "policy_epoch", "reader_key", "relation_type", "node_ref"],
    }),
    countSeedSql = dialectUpsertValuesSql(capabilities, {
      table: "ha_relation_cycle_count",
      columns: [
        { name: "tenant_id", valueSql: "COALESCE(NEW.tenant_id,OLD.tenant_id)" },
        { name: "project_id", valueSql: "COALESCE(NEW.project_id,OLD.project_id)" },
        { name: "policy_epoch", valueSql: "COALESCE(NEW.policy_epoch,OLD.policy_epoch)" },
        { name: "reader_key", valueSql: "'{}'::text[]" },
        { name: "singleton", valueSql: "true" },
        { name: "edge_count", valueSql: "0::bigint" },
      ],
      conflictColumns: ["tenant_id", "project_id", "policy_epoch", "reader_key", "singleton"],
    }),
    edgeTriggerUpsertSql = dialectUpsertValuesSql(capabilities, {
      table: "ha_relation_cycle_edge",
      columns: [
        { name: "tenant_id", valueSql: "NEW.tenant_id" },
        { name: "project_id", valueSql: "NEW.project_id" },
        { name: "policy_epoch", valueSql: "NEW.policy_epoch" },
        { name: "relation_id", valueSql: "NEW.relation_id" },
        { name: "source_ref", valueSql: "NEW.source_ref" },
        { name: "target_ref", valueSql: "NEW.target_ref" },
        { name: "relation_type", valueSql: "NEW.relation_type" },
        { name: "direction", valueSql: "NEW.value->>'direction'" },
        { name: "relation_state", valueSql: "NEW.relation_state" },
        { name: "readers", valueSql: "NEW.readers" },
      ],
      conflictColumns: ["tenant_id", "project_id", "policy_epoch", "relation_id"],
      updates: [
        { column: "source_ref", valueSql: "EXCLUDED.source_ref" },
        { column: "target_ref", valueSql: "EXCLUDED.target_ref" },
        { column: "relation_type", valueSql: "EXCLUDED.relation_type" },
        { column: "direction", valueSql: "EXCLUDED.direction" },
        { column: "relation_state", valueSql: "EXCLUDED.relation_state" },
        { column: "readers", valueSql: "EXCLUDED.readers" },
      ],
    });
  return [
    /* @gate-identity state-store/task.projection.ha_relation_cycle_edge */ `CREATE TABLE IF NOT EXISTS ha_relation_cycle_edge (
      ${POSTGRES_SCOPE_COLUMNS_SQL}, relation_id text NOT NULL, source_ref text NOT NULL, target_ref text NOT NULL,
      relation_type text NOT NULL, direction text NOT NULL, relation_state text NOT NULL, readers text[] NOT NULL DEFAULT '{}',
      PRIMARY KEY (tenant_id,project_id,policy_epoch,relation_id)
    )`,
    /* @gate-identity state-store/task.projection.ha_relation_cycle_count */ `CREATE TABLE IF NOT EXISTS ha_relation_cycle_count (
      ${POSTGRES_SCOPE_COLUMNS_SQL}, reader_key text[] NOT NULL, singleton boolean NOT NULL DEFAULT true, edge_count bigint NOT NULL DEFAULT 0,
      backfill_cursor text, backfill_complete boolean NOT NULL DEFAULT false,
      PRIMARY KEY (tenant_id,project_id,policy_epoch,reader_key,singleton)
    )`,
    /* @gate-identity state-store/task.projection.ha_relation_cycle_dirty */ `CREATE TABLE IF NOT EXISTS ha_relation_cycle_dirty (
      ${POSTGRES_SCOPE_COLUMNS_SQL}, reader_key text[] NOT NULL, relation_type text NOT NULL, node_ref text NOT NULL,
      PRIMARY KEY (tenant_id,project_id,policy_epoch,reader_key,relation_type,node_ref)
    )`,
    /* @gate-identity state-store/task.projection.ha_relation_cycle_component */ `CREATE TABLE IF NOT EXISTS ha_relation_cycle_component (
      ${POSTGRES_SCOPE_COLUMNS_SQL}, reader_key text[] NOT NULL, component_id text NOT NULL, relation_type text NOT NULL,
      priority text NOT NULL, issue_json jsonb NOT NULL, left_id text, right_id text, height integer NOT NULL DEFAULT 1,
      PRIMARY KEY (tenant_id,project_id,policy_epoch,reader_key,component_id)
    )`,
    /* @gate-identity state-store/task.projection.ha_relation_cycle_member */ `CREATE TABLE IF NOT EXISTS ha_relation_cycle_member (
      ${POSTGRES_SCOPE_COLUMNS_SQL}, reader_key text[] NOT NULL, relation_type text NOT NULL, node_ref text NOT NULL, component_id text NOT NULL,
      PRIMARY KEY (tenant_id,project_id,policy_epoch,reader_key,relation_type,node_ref)
    )`,
    /* @gate-identity state-store/task.projection.ha_relation_cycle_result */ `CREATE TABLE IF NOT EXISTS ha_relation_cycle_result (
      ${POSTGRES_SCOPE_COLUMNS_SQL}, reader_key text[] NOT NULL, relation_type text NOT NULL, root_component_id text NOT NULL, issue_json jsonb NOT NULL,
      PRIMARY KEY (tenant_id,project_id,policy_epoch,reader_key,relation_type)
    )`,
    "CREATE INDEX IF NOT EXISTS ha_relation_cycle_edge_source ON ha_relation_cycle_edge (tenant_id,project_id,policy_epoch,relation_type,source_ref)",
    "CREATE INDEX IF NOT EXISTS ha_relation_cycle_edge_target ON ha_relation_cycle_edge (tenant_id,project_id,policy_epoch,relation_type,target_ref)",
    "CREATE INDEX IF NOT EXISTS ha_relation_cycle_member_component ON ha_relation_cycle_member (tenant_id,project_id,policy_epoch,reader_key,component_id)",
    `CREATE OR REPLACE FUNCTION ha_relation_cycle_mark(tenant text, project text, epoch bigint, kind text, node text, visibility text[])
      RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF kind = ANY(ARRAY[${acyclicSql}]::text[]) THEN
          ${dirtyMarkSql};
        END IF;
      END $function$`,
    `CREATE OR REPLACE FUNCTION ha_relation_cycle_sync() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF TG_OP = 'UPDATE' AND
          (NEW.tenant_id,NEW.project_id,NEW.policy_epoch,NEW.relation_id,NEW.source_ref,NEW.target_ref,NEW.relation_type,NEW.relation_state,NEW.value->>'direction',NEW.readers)
          IS NOT DISTINCT FROM
          (OLD.tenant_id,OLD.project_id,OLD.policy_epoch,OLD.relation_id,OLD.source_ref,OLD.target_ref,OLD.relation_type,OLD.relation_state,OLD.value->>'direction',OLD.readers)
        THEN RETURN NEW; END IF;
        ${countSeedSql};
        PERFORM 1 FROM ha_relation_cycle_count WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
          AND project_id=COALESCE(NEW.project_id,OLD.project_id) AND policy_epoch=COALESCE(NEW.policy_epoch,OLD.policy_epoch)
          AND reader_key='{}' AND singleton FOR UPDATE;
        IF TG_OP <> 'INSERT' THEN
          DELETE FROM ha_relation_cycle_edge WHERE tenant_id=OLD.tenant_id AND project_id=OLD.project_id
            AND policy_epoch=OLD.policy_epoch AND relation_id=OLD.relation_id;
          PERFORM ha_relation_cycle_mark(OLD.tenant_id,OLD.project_id,OLD.policy_epoch,OLD.relation_type,OLD.source_ref,OLD.readers);
          PERFORM ha_relation_cycle_mark(OLD.tenant_id,OLD.project_id,OLD.policy_epoch,OLD.relation_type,OLD.target_ref,OLD.readers);
          UPDATE ha_relation_cycle_count SET edge_count=edge_count-1
          WHERE tenant_id=OLD.tenant_id AND project_id=OLD.project_id AND policy_epoch=OLD.policy_epoch AND singleton
            AND (cardinality(reader_key)=0 OR reader_key && OLD.readers)
            AND (backfill_complete OR (backfill_cursor IS NOT NULL AND OLD.relation_id <= backfill_cursor));
        END IF;
        IF TG_OP <> 'DELETE' THEN
          IF NEW.relation_type IN (${acyclicSql}) THEN
            ${edgeTriggerUpsertSql};
          END IF;
          PERFORM ha_relation_cycle_mark(NEW.tenant_id,NEW.project_id,NEW.policy_epoch,NEW.relation_type,NEW.source_ref,NEW.readers);
          PERFORM ha_relation_cycle_mark(NEW.tenant_id,NEW.project_id,NEW.policy_epoch,NEW.relation_type,NEW.target_ref,NEW.readers);
          UPDATE ha_relation_cycle_count SET edge_count=edge_count+1
          WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND policy_epoch=NEW.policy_epoch AND singleton
            AND (cardinality(reader_key)=0 OR reader_key && NEW.readers)
            AND (backfill_complete OR (backfill_cursor IS NOT NULL AND NEW.relation_id <= backfill_cursor));
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_relations_relation_cycle_sync",
      tableName: "ha_relations",
      timingAndEvent: "AFTER INSERT OR UPDATE OR DELETE",
      functionCall: "ha_relation_cycle_sync()",
    }),
  ];
}

/** One bounded page commits a reproducible cursor; the scoped count row serializes it with relation triggers. */
export async function backfillPgRelationCycleAuditPage(
  client: PoolClient,
  scope: PgRelationCycleScope,
  pageSize = 512,
): Promise<PgRelationCycleRefreshPage> {
  checkedPageLimit(pageSize, 4096);
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    readers = [...new Set(scope.readers ?? [])].sort(),
    capabilities = getClientDialectCapabilities(client);
  // The all-reader row serializes every visibility cache with relation triggers, in one lock order.
  await client.query(
    dialectUpsertValuesSql(capabilities, {
      table: "ha_relation_cycle_count",
      columns: [
        { name: "tenant_id", valueSql: "$1::text" },
        { name: "project_id", valueSql: "$2::text" },
        { name: "policy_epoch", valueSql: "$3::bigint" },
        { name: "reader_key", valueSql: "'{}'::text[]" },
        { name: "singleton", valueSql: "true" },
        { name: "edge_count", valueSql: "0::bigint" },
      ],
      conflictColumns: ["tenant_id", "project_id", "policy_epoch", "reader_key", "singleton"],
    }),
    keys,
  );
  await client.query(
    `SELECT 1 FROM ha_relation_cycle_count WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key='{}' AND singleton FOR UPDATE`,
    keys,
  );
  await client.query(
    dialectUpsertValuesSql(capabilities, {
      table: "ha_relation_cycle_count",
      columns: [
        { name: "tenant_id", valueSql: "$1::text" },
        { name: "project_id", valueSql: "$2::text" },
        { name: "policy_epoch", valueSql: "$3::bigint" },
        { name: "reader_key", valueSql: "$4::text[]" },
        { name: "singleton", valueSql: "true" },
        { name: "edge_count", valueSql: "0::bigint" },
      ],
      conflictColumns: ["tenant_id", "project_id", "policy_epoch", "reader_key", "singleton"],
    }),
    [...keys, readers],
  );
  const state = (
    await client.query<{ backfill_cursor: string | null; backfill_complete: boolean }>(
      `SELECT backfill_cursor,backfill_complete FROM ha_relation_cycle_count
         WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 AND singleton FOR UPDATE`,
      [...keys, readers],
    )
  ).rows[0]!;
  if (state.backfill_complete) return { processed: 0, done: true };
  const rows = (
    await client.query<{
      relation_id: string;
      source_ref: string;
      target_ref: string;
      relation_type: string;
      direction: string;
      relation_state: string;
      readers: string[];
    }>(
      `SELECT relation_id,source_ref,target_ref,relation_type,value->>'direction' AS direction,relation_state,readers FROM ha_relations
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND ($4::text IS NULL OR relation_id>$4)
       ORDER BY relation_id LIMIT $5`,
      [...keys, state.backfill_cursor, pageSize + 1],
    )
  ).rows;
  const page = rows.slice(0, pageSize),
    hasMore = rows.length > pageSize,
    cursor = page.at(-1)?.relation_id ?? state.backfill_cursor;
  if (page.length) {
    if (capabilities.supportsExtendedJsonb && capabilities.supportsLateralJoin && capabilities.supportsOnConflict) {
      await client.query(
        `INSERT INTO ha_relation_cycle_edge(tenant_id,project_id,policy_epoch,relation_id,source_ref,target_ref,relation_type,direction,relation_state,readers)
         SELECT $1,$2,$3,row.relation_id,row.source_ref,row.target_ref,row.relation_type,row.direction,row.relation_state,row.readers
         FROM jsonb_to_recordset($4::jsonb) AS row(relation_id text,source_ref text,target_ref text,relation_type text,direction text,relation_state text,readers text[])
         WHERE row.relation_type=ANY($5::text[])
         ON CONFLICT (tenant_id,project_id,policy_epoch,relation_id) DO UPDATE SET
           source_ref=EXCLUDED.source_ref,target_ref=EXCLUDED.target_ref,relation_type=EXCLUDED.relation_type,
           direction=EXCLUDED.direction,relation_state=EXCLUDED.relation_state,readers=EXCLUDED.readers`,
        [...keys, JSON.stringify(page), acyclicTypes],
      );
      await client.query(
        `INSERT INTO ha_relation_cycle_dirty(tenant_id,project_id,policy_epoch,reader_key,relation_type,node_ref)
         SELECT $1,$2,$3,$4,edge.relation_type,endpoint.node_ref
         FROM jsonb_to_recordset($5::jsonb) AS edge(relation_type text,source_ref text,target_ref text,readers text[])
         CROSS JOIN LATERAL (VALUES (edge.source_ref),(edge.target_ref)) AS endpoint(node_ref)
         WHERE edge.relation_type=ANY($6::text[]) AND (cardinality($4::text[])=0 OR edge.readers && $4::text[])
         ON CONFLICT (tenant_id,project_id,policy_epoch,reader_key,relation_type,node_ref) DO NOTHING`,
        [...keys, readers, JSON.stringify(page), acyclicTypes],
      );
    } else {
      const edgeRowSql = dialectUpsertValuesSql(capabilities, {
          table: "ha_relation_cycle_edge",
          columns: [
            { name: "tenant_id", valueSql: "$1::text" },
            { name: "project_id", valueSql: "$2::text" },
            { name: "policy_epoch", valueSql: "$3::bigint" },
            { name: "relation_id", valueSql: "$4::text" },
            { name: "source_ref", valueSql: "$5::text" },
            { name: "target_ref", valueSql: "$6::text" },
            { name: "relation_type", valueSql: "$7::text" },
            { name: "direction", valueSql: "$8::text" },
            { name: "relation_state", valueSql: "$9::text" },
            { name: "readers", valueSql: "$10::text[]" },
          ],
          conflictColumns: ["tenant_id", "project_id", "policy_epoch", "relation_id"],
          updates: [
            { column: "source_ref", valueSql: "EXCLUDED.source_ref" },
            { column: "target_ref", valueSql: "EXCLUDED.target_ref" },
            { column: "relation_type", valueSql: "EXCLUDED.relation_type" },
            { column: "direction", valueSql: "EXCLUDED.direction" },
            { column: "relation_state", valueSql: "EXCLUDED.relation_state" },
            { column: "readers", valueSql: "EXCLUDED.readers" },
          ],
        }),
        dirtyRowSql = dialectUpsertValuesSql(capabilities, {
          table: "ha_relation_cycle_dirty",
          columns: [
            { name: "tenant_id", valueSql: "$1::text" },
            { name: "project_id", valueSql: "$2::text" },
            { name: "policy_epoch", valueSql: "$3::bigint" },
            { name: "reader_key", valueSql: "$4::text[]" },
            { name: "relation_type", valueSql: "$5::text" },
            { name: "node_ref", valueSql: "$6::text" },
          ],
          conflictColumns: ["tenant_id", "project_id", "policy_epoch", "reader_key", "relation_type", "node_ref"],
        });
      for (const row of page) {
        if (!acyclicTypes.includes(row.relation_type as (typeof acyclicTypes)[number])) continue;
        await client.query(edgeRowSql, [
          ...keys,
          row.relation_id,
          row.source_ref,
          row.target_ref,
          row.relation_type,
          row.direction,
          row.relation_state,
          row.readers,
        ]);
        if (readers.length === 0 || row.readers.some((reader) => readers.includes(reader))) {
          for (const endpoint of [row.source_ref, row.target_ref]) {
            await client.query(dirtyRowSql, [...keys, readers, row.relation_type, endpoint]);
          }
        }
      }
    }
  }
  const done = !hasMore;
  await client.query(
    `UPDATE ha_relation_cycle_count SET edge_count=edge_count+$5,backfill_cursor=$6,backfill_complete=$7
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 AND singleton`,
    [
      ...keys,
      readers,
      page.filter((row) => !readers.length || row.readers.some((reader) => readers.includes(reader))).length,
      cursor,
      done,
    ],
  );
  return { processed: page.length, done };
}

/** Deletes and replaces a page of cached components atomically; readers reject the intermediate dirty state. */
async function refreshPgRelationCycleAuditPage(
  client: PoolClient,
  scope: PgRelationCycleScope,
  pageSize = 256,
): Promise<PgRelationCycleRefreshPage> {
  checkedPageLimit(pageSize, 4096);
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch, [...new Set(scope.readers ?? [])].sort()];
  const dirty = await client.query<{ relation_type: string; node_ref: string }>(
    `WITH selected AS (
       SELECT tenant_id,project_id,policy_epoch,reader_key,relation_type,node_ref FROM ha_relation_cycle_dirty
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 ORDER BY relation_type,node_ref LIMIT $5 FOR UPDATE
     )
     DELETE FROM ha_relation_cycle_dirty AS target USING selected
     WHERE target.tenant_id=selected.tenant_id AND target.project_id=selected.project_id AND target.policy_epoch=selected.policy_epoch AND target.reader_key=selected.reader_key
       AND target.relation_type=selected.relation_type AND target.node_ref=selected.node_ref
     RETURNING target.relation_type,target.node_ref`,
    [...keys, pageSize],
  );
  if (!dirty.rows.length) return { processed: 0, done: true };
  for (const relationType of new Set(dirty.rows.map(({ relation_type }) => relation_type))) {
    const seeds = new Set(
        dirty.rows.filter((row) => row.relation_type === relationType).map(({ node_ref }) => node_ref),
      ),
      visited = new Set<string>();
    let winners: PgRelationCycleWinners | undefined;
    const index = async () => (winners ??= await PgRelationCycleWinners.open(client, [...keys, relationType]));
    for (const seed of seeds) {
      if (visited.has(seed)) continue;
      const nodes = new Set([seed]),
        edges = new Map<string, RelationCycleEdge>();
      for (const node of nodes) {
        visited.add(node);
        const rows = await client.query<{
          relation_id: string;
          source_ref: string;
          target_ref: string;
          relation_type: string;
          direction: string;
          relation_state: string;
        }>(
          `SELECT relation_id,source_ref,target_ref,relation_type,direction,relation_state FROM ha_relation_cycle_edge
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) AND relation_type=$5 AND relation_state='active' AND direction='directed'
             AND (source_ref=$6 OR target_ref=$6)`,
          [...keys, relationType, node],
        );
        // A selected dirty seed may enter an old cyclic component whose own dirty marker
        // is beyond this page. Invalidate every component reached, and revisit its old members
        // as separate seeds: deletions may have split them into several current components.
        const previous = await client.query<{ component_id: string }>(
          "SELECT component_id FROM ha_relation_cycle_member WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 AND relation_type=$5 AND node_ref=$6",
          [...keys, relationType, node],
        );
        for (const { component_id } of previous.rows) {
          const oldNodes = await client.query<{ node_ref: string }>(
            "DELETE FROM ha_relation_cycle_member WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 AND component_id=$5 RETURNING node_ref",
            [...keys, component_id],
          );
          for (const { node_ref } of oldNodes.rows) seeds.add(node_ref);
          await (await index()).remove(component_id);
        }
        for (const row of rows.rows) {
          edges.set(row.relation_id, {
            relationId: row.relation_id,
            sourceRef: row.source_ref,
            targetRef: row.target_ref,
            relationType: row.relation_type as RelationCycleEdge["relationType"],
            direction: row.direction as RelationCycleEdge["direction"],
            state: row.relation_state as RelationCycleEdge["state"],
          });
          nodes.add(row.source_ref);
          nodes.add(row.target_ref);
        }
      }
      const witness = findRelationCycleWitnesses([...edges.values()])[0];
      await client.query(
        "DELETE FROM ha_relation_cycle_dirty WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 AND relation_type=$5 AND node_ref=ANY($6::text[])",
        [...keys, relationType, [...nodes]],
      );
      if (!witness) continue;
      const reaching = new Set(witness.nodeRefs),
        reverse = new Map<string, string[]>();
      for (const edge of edges.values())
        reverse.set(edge.targetRef, [...(reverse.get(edge.targetRef) ?? []), edge.sourceRef]);
      for (const node of reaching) for (const previous of reverse.get(node) ?? []) reaching.add(previous);
      const priority = [...reaching].sort((left, right) => left.localeCompare(right))[0]!;
      const componentId = `${relationType}:${[...nodes].sort()[0]}`;
      const issue = { code: "relation_cycle_detected" as const, ...witness };
      await (await index()).insert(componentId, priority, issue);
      await client.query(
        `INSERT INTO ha_relation_cycle_member(tenant_id,project_id,policy_epoch,reader_key,relation_type,node_ref,component_id)
         SELECT $1,$2,$3,$4,$5,node,$6 FROM unnest($7::text[]) AS node`,
        [...keys, relationType, componentId, [...nodes]],
      );
    }
    if (winners) await winners.publish();
  }
  const remaining = await client.query(
    "SELECT 1 FROM ha_relation_cycle_dirty WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 LIMIT 1",
    keys,
  );
  return { processed: dirty.rows.length, done: !remaining.rowCount };
}

export async function maintainPgRelationCycleAuditPage(
  client: PoolClient,
  scope: PgRelationCycleScope,
): Promise<PgRelationCycleRefreshPage> {
  const backfill = await backfillPgRelationCycleAuditPage(client, scope);
  if (!backfill.done) return backfill;
  const refresh = await refreshPgRelationCycleAuditPage(client, scope);
  return { processed: backfill.processed + refresh.processed, done: refresh.done };
}

export async function readPgRelationCycleAudit(
  client: PoolClient,
  scope: PgRelationCycleScope,
): Promise<RelationCycleAudit> {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch, [...new Set(scope.readers ?? [])].sort()],
    count = await client.query<{ edge_count: string; backfill_complete: boolean }>(
      "SELECT edge_count::text,backfill_complete FROM ha_relation_cycle_count WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 AND singleton",
      keys,
    );
  if (!count.rows[0]?.backfill_complete) throw new PgRelationCyclePendingError();
  const dirty = await client.query(
    "SELECT 1 FROM ha_relation_cycle_dirty WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 LIMIT 1",
    keys,
  );
  if (dirty.rowCount) throw new PgRelationCyclePendingError();
  const results = await client.query<{ issue_json: RelationCycleIssue }>(
    "SELECT issue_json FROM ha_relation_cycle_result WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 ORDER BY relation_type",
    keys,
  );
  return { scannedEdges: Number(count.rows[0].edge_count), issues: results.rows.map(({ issue_json }) => issue_json) };
}

/** A readiness failure is a coded storage error, not an authored state transition. */
class PgRelationCyclePendingError extends Error {
  readonly code = "projection_pending";
  constructor() {
    super("Relation cycle projection refresh is pending");
  }
}
