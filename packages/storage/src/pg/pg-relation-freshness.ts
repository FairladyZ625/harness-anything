import type { PoolClient } from "pg";
import {
  relationFreshnessAnchorForType,
  relationTypes,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import type { RelationType } from "@harness-anything/kernel/internal/domain/relation-type-registry.ts";
import type { EntityVersion } from "@harness-anything/kernel/internal/domain/entity-freshness.ts";
import { POSTGRES_SCOPE_COLUMNS_SQL } from "../postgres/scope-schema.ts";
import { relationFreshnessColumns } from "../projection/relation-freshness-columns.ts";
import { readEntityVersionWitnesses } from "./pg-relation-queries.ts";
import { PG_RELATION_FRESHNESS_DIRTY_TABLE, pgRelationFreshnessReady } from "./pg-relation-freshness-readiness.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

/**
 * dec_E34C4284B48AFAF152D7BF1980: relation freshness is one global value stored on ha_relations.
 * Endpoint tables record changed refs through triggers (for current and previous writers alike);
 * the current writer drains them inside the same materialization transaction, recomputing only
 * the relations anchored on those refs with the kernel judgment over unfiltered witnesses.
 *
 * Expansion step: the columns are nullable and filled by `backfillPgRelationFreshnessPage`.
 * Until a scope has no unfilled row and no undrained ref, readers keep the previous witness path
 * (`pgRelationFreshnessReady`). Remove that previous read path, the readiness probe and the
 * pending index on 2026-11-26, after pre-freshness binaries have drained.
 */

const sourceAnchoredTypes = relationTypes.filter((type) => relationFreshnessAnchorForType(type) === "source");

const endpointTables = [
  { table: "ha_task_snapshots", ref: "'task/' || {row}.task_id", columns: ["workspace_revision"] },
  { table: "ha_decisions", ref: "'decision/' || {row}.decision_id", columns: ["workspace_revision", "value"] },
  { table: "ha_facts", ref: "'fact/' || {row}.fact_id", columns: ["workspace_revision"] },
  { table: "ha_agents", ref: "'agent/' || {row}.agent_id", columns: ["workspace_revision"] },
  { table: "ha_squads", ref: "'squad/' || {row}.squad_id", columns: ["workspace_revision"] },
] as const;

export function relationFreshnessDdl(): readonly string[] {
  return [
    "ALTER TABLE ha_relations ADD COLUMN IF NOT EXISTS freshness text",
    "ALTER TABLE ha_relations ADD COLUMN IF NOT EXISTS current_target_version jsonb",
    `CREATE TABLE IF NOT EXISTS ${PG_RELATION_FRESHNESS_DIRTY_TABLE} (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      ref text NOT NULL,
      PRIMARY KEY (tenant_id, project_id, policy_epoch, ref)
    )`,
    `CREATE OR REPLACE FUNCTION ha_relation_freshness_mark(tenant text, project text, epoch bigint, changed text)
      RETURNS void LANGUAGE sql SET search_path FROM CURRENT AS $function$
        INSERT INTO ${PG_RELATION_FRESHNESS_DIRTY_TABLE}(tenant_id, project_id, policy_epoch, ref)
        VALUES (tenant, project, epoch, changed) ON CONFLICT DO NOTHING
      $function$`,
    ...endpointTables.flatMap(({ table, ref, columns }) => endpointTriggerDdl(table, ref, columns)),
    // A relation row is an endpoint of relations targeting `relation/<id>`; an executes row also
    // supplies its execution source's witness.
    `CREATE OR REPLACE FUNCTION ha_relation_freshness_relation_changed() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE changed record;
      BEGIN
        IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
        PERFORM ha_relation_freshness_mark(changed.tenant_id, changed.project_id, changed.policy_epoch,
          'relation/' || changed.relation_id);
        IF changed.relation_type = 'executes' THEN
          PERFORM ha_relation_freshness_mark(changed.tenant_id, changed.project_id, changed.policy_epoch,
            changed.source_ref);
        END IF;
        RETURN NULL;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_relations_freshness_insert AFTER INSERT OR DELETE ON ha_relations
      FOR EACH ROW EXECUTE FUNCTION ha_relation_freshness_relation_changed()`,
    `CREATE OR REPLACE TRIGGER ha_relations_freshness_update AFTER UPDATE OF workspace_revision, value ON ha_relations
      FOR EACH ROW WHEN (OLD.workspace_revision IS DISTINCT FROM NEW.workspace_revision OR OLD.value IS DISTINCT FROM NEW.value)
      EXECUTE FUNCTION ha_relation_freshness_relation_changed()`,
    `CREATE OR REPLACE FUNCTION ha_relation_freshness_entity_changed() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE changed record;
      BEGIN
        IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
        PERFORM ha_relation_freshness_mark(changed.tenant_id, changed.project_id, changed.policy_epoch,
          substr(changed.model, 8) || '/' || changed.entity_id);
        RETURN NULL;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_projection_values_freshness_insert AFTER INSERT ON ha_projection_values
      FOR EACH ROW WHEN (starts_with(NEW.model, 'entity:'))
      EXECUTE FUNCTION ha_relation_freshness_entity_changed()`,
    `CREATE OR REPLACE TRIGGER ha_projection_values_freshness_delete AFTER DELETE ON ha_projection_values
      FOR EACH ROW WHEN (starts_with(OLD.model, 'entity:'))
      EXECUTE FUNCTION ha_relation_freshness_entity_changed()`,
    `CREATE OR REPLACE TRIGGER ha_projection_values_freshness_update AFTER UPDATE OF value, workspace_revision ON ha_projection_values
      FOR EACH ROW WHEN (starts_with(NEW.model, 'entity:') AND
        (OLD.value IS DISTINCT FROM NEW.value OR OLD.workspace_revision IS DISTINCT FROM NEW.workspace_revision))
      EXECUTE FUNCTION ha_relation_freshness_entity_changed()`,
    "CREATE INDEX IF NOT EXISTS ha_relations_freshness_page ON ha_relations (tenant_id,project_id,policy_epoch,freshness,relation_id)",
    "CREATE INDEX IF NOT EXISTS ha_relations_freshness_pending ON ha_relations (tenant_id,project_id,policy_epoch,relation_id) WHERE freshness IS NULL",
  ];
}

function endpointTriggerDdl(table: string, ref: string, columns: readonly string[]): readonly string[] {
  const fn = `${table}_relation_freshness_changed`,
    changed = columns.map((column) => `OLD.${column} IS DISTINCT FROM NEW.${column}`).join(" OR ");
  return [
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          PERFORM ha_relation_freshness_mark(OLD.tenant_id, OLD.project_id, OLD.policy_epoch, ${ref.replaceAll("{row}", "OLD")});
        ELSE
          PERFORM ha_relation_freshness_mark(NEW.tenant_id, NEW.project_id, NEW.policy_epoch, ${ref.replaceAll("{row}", "NEW")});
        END IF;
        RETURN NULL;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ${table}_freshness_insert AFTER INSERT OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    `CREATE OR REPLACE TRIGGER ${table}_freshness_update AFTER UPDATE OF ${columns.join(", ")} ON ${table}
      FOR EACH ROW WHEN (${changed}) EXECUTE FUNCTION ${fn}()`,
  ];
}

interface RelationFreshnessInput {
  readonly relation_id: string;
  readonly source_ref: string;
  readonly target_ref: string;
  readonly relation_type: string;
  readonly target_observed_version: EntityVersion | null;
  readonly freshness: string | null;
  readonly current_target_version: EntityVersion | null;
}

const relationInputColumns =
  "relation_id, source_ref, target_ref, relation_type, value->'targetObservedVersion' AS target_observed_version, freshness, current_target_version";

/**
 * Drain the refs changed in this transaction and recompute the relations anchored on them: edges
 * targeting the ref or one of its `<ref>/<anchor>` forms, source-anchored edges leaving it, and a
 * changed relation itself. Each arm is one endpoint index range. Returns the recomputed count.
 */
export async function refreshPgDirtyRelationFreshness(client: PoolClient, scope: PgProjectionScope): Promise<number> {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    dirty = await client.query<{ ref: string }>(
      `DELETE FROM ${PG_RELATION_FRESHNESS_DIRTY_TABLE} WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 RETURNING ref`,
      keys,
    );
  if (dirty.rows.length === 0) return 0;
  const affected = await client.query<RelationFreshnessInput>(
    `SELECT DISTINCT ON (relation_id) ${relationInputColumns} FROM (
       SELECT r.* FROM unnest($4::text[]) d(ref) CROSS JOIN LATERAL (
         SELECT * FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
           AND target_ref COLLATE "C" >= d.ref AND target_ref COLLATE "C" < d.ref || '0'
         UNION ALL
         SELECT * FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
           AND source_ref COLLATE "C" >= d.ref AND source_ref COLLATE "C" < d.ref || '0'
           AND relation_type = ANY($5::text[])
         UNION ALL
         SELECT * FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
           AND starts_with(d.ref, 'relation/') AND relation_id = substr(d.ref, 10)
       ) r
     ) affected ORDER BY relation_id`,
    [...keys, dirty.rows.map(({ ref }) => ref), sourceAnchoredTypes],
  );
  await storePgRelationFreshness(client, scope, affected.rows);
  return affected.rows.length;
}

/**
 * Expansion backfill: fill one bounded page of rows written before the column existed (or by a
 * previous writer) and drain refs previous writers marked. `done` means the scope is ready for the
 * stored-value read path. Run one call per management transaction with the scope's claims.
 */
export async function backfillPgRelationFreshnessPage(
  client: PoolClient,
  scope: PgProjectionScope,
): Promise<{ readonly processed: number; readonly done: boolean }> {
  const pending = await client.query<RelationFreshnessInput>(
    `SELECT ${relationInputColumns} FROM ha_relations
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND freshness IS NULL
     ORDER BY relation_id LIMIT 256 FOR UPDATE`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  await storePgRelationFreshness(client, scope, pending.rows);
  const drained = await refreshPgDirtyRelationFreshness(client, scope);
  return {
    processed: pending.rows.length + drained,
    done: pending.rows.length === 0 && drained === 0 && (await pgRelationFreshnessReady(client, scope)),
  };
}

async function storePgRelationFreshness(
  client: PoolClient,
  scope: PgProjectionScope,
  rows: readonly RelationFreshnessInput[],
): Promise<void> {
  if (rows.length === 0) return;
  // Global witnesses: an empty reader set applies no reader filter.
  const witnesses = await readEntityVersionWitnesses(
    client,
    scope,
    [],
    [
      ...new Set(
        rows.flatMap((row) =>
          relationFreshnessAnchorForType(row.relation_type as RelationType) === "source"
            ? [row.target_ref, row.source_ref]
            : [row.target_ref],
        ),
      ),
    ],
  );
  const changed = rows.flatMap((row) => {
    const next = relationFreshnessColumns(
      {
        type: row.relation_type as RelationType,
        target: row.target_ref,
        targetObservedVersion: row.target_observed_version,
      },
      witnesses.get(row.target_ref)!,
      witnesses.get(row.source_ref),
    );
    return next.freshness === row.freshness && next.currentTargetVersion === row.current_target_version
      ? []
      : [
          {
            relation_id: row.relation_id,
            freshness: next.freshness,
            current_target_version: next.currentTargetVersion,
          },
        ];
  });
  if (changed.length === 0) return;
  await client.query(
    `UPDATE ha_relations AS r SET freshness = u.freshness, current_target_version = u.current_target_version
     FROM jsonb_to_recordset($4::jsonb) AS u(relation_id text, freshness text, current_target_version jsonb)
     WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.policy_epoch=$3 AND r.relation_id = u.relation_id`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, JSON.stringify(changed)],
  );
}
