import { sqliteImportedTaskPinPredicate } from "./projection-tables.ts";
import {
  personalPinsFromNewest,
  pinRetirementEventTypes,
} from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import type { DatabaseSync } from "node:sqlite";
import { runtimeSessionEntityV1, type RuntimeSession } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  deriveEntityProjection,
  interpretEmbeddedEntityProjections,
  interpretEntityValue,
  type InterpretedEntityValue,
  type InterpretedEntityProjection,
} from "@harness-anything/kernel/internal/domain/entity-kind-projection.ts";
import {
  entityKindContracts,
  type EntityKindContract,
} from "@harness-anything/kernel/internal/domain/entity-kind-registry.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
import type { EntityProjectionRow, PinnedEntityProjectionRow } from "@harness-anything/kernel";
import { entityValueFilterEntries } from "./entity-value-filter.ts";
import type { EntityFreshness, EntityVersion } from "@harness-anything/kernel/internal/domain/entity-freshness.ts";

const UPSERT_ENTITY_SQL = [
  "INSERT INTO entity_projection(entity_kind, entity_id, task_id, workspace_revision,",
  "freshness, current_version, value_json)",
  "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(entity_kind, task_id, entity_id) DO UPDATE SET",
  "workspace_revision=excluded.workspace_revision, freshness=excluded.freshness,",
  "current_version=excluded.current_version, value_json=excluded.value_json",
  "WHERE entity_projection.workspace_revision <= excluded.workspace_revision",
].join(" ");
const LIST_ENTITY_SQL = [
  "SELECT entity_kind, entity_id, task_id, workspace_revision, freshness, current_version, value_json",
  "FROM entity_projection",
  "WHERE entity_kind = ? ORDER BY entity_id, task_id",
].join(" ");
const GET_ENTITY_SQL = [
  "SELECT entity_kind, entity_id, task_id, workspace_revision, freshness, current_version, value_json",
  "FROM entity_projection",
  "WHERE entity_kind = ? AND entity_id = ? ORDER BY workspace_revision DESC LIMIT 1",
].join(" ");

export function projectEmbeddedCanonicalEntities(db: DatabaseSync, event: CanonicalEventV1): void {
  for (const contract of entityKindContracts)
    for (const projection of interpretEmbeddedEntityProjections(contract, event))
      writeEntityProjection(db, projection, "current", projection.workspaceRevision);
}

export function projectRuntimeSessionCanonicalEntity(
  db: DatabaseSync,
  session: RuntimeSession,
  workspaceRevision: number,
  sourcePath: string,
): void {
  const contract = entityKindContracts.find(({ kind }) => kind === "runtime-session");
  if (!contract) throw new Error("RuntimeSession EntityKindContract is unavailable");
  projectInterpretedEntityValue(
    db,
    contract,
    interpretEntityValue(contract, runtimeSessionEntityV1(session)),
    workspaceRevision,
    sourcePath,
  );
}

export function projectInterpretedEntityValue(
  db: DatabaseSync,
  contract: EntityKindContract,
  entity: InterpretedEntityValue,
  workspaceRevision: number,
  sourcePath: string,
  freshness: EntityFreshness = "current",
  currentVersion: EntityVersion | null = workspaceRevision,
): InterpretedEntityProjection | null {
  const projection = deriveEntityProjection(contract, entity, workspaceRevision, sourcePath);
  if (projection !== null) writeEntityProjection(db, projection, freshness, currentVersion);
  return projection;
}

function writeEntityProjection(
  db: DatabaseSync,
  projection: InterpretedEntityProjection,
  freshness: EntityFreshness,
  currentVersion: EntityVersion | null,
): void {
  runSql(
    db,
    UPSERT_ENTITY_SQL,
    projection.kind,
    projection.id,
    projection.ownerId ?? "",
    projection.workspaceRevision,
    freshness,
    currentVersion,
    canonicalJson(projection.value),
  );
}

export function listEntityProjectionRows(
  db: DatabaseSync,
  entityKind: string,
  withAttribution = false,
): readonly EntityProjectionRow[] {
  const rows = queryRows(db, LIST_ENTITY_SQL, entityKind).map(entityProjectionRow);
  return entityKind === "todo" || withAttribution ? projectEntityOrigins(db, entityKind, rows) : rows;
}

/** Count one entity kind at the storage boundary, filtered by top-level value fields. */
export function countEntityProjectionRows(
  db: DatabaseSync,
  entityKind: string,
  valueEquals: Readonly<Record<string, string | number | boolean>>,
): number {
  const entries = entityValueFilterEntries(valueEquals),
    filters = entries.map(([field]) => `json_extract(value_json, '$.${field}') = ?`),
    row = queryRows(
      db,
      [
        "SELECT COUNT(*) AS count FROM entity_projection WHERE entity_kind = ?",
        ...(filters.length === 0 ? [] : [`AND ${filters.join(" AND ")}`]),
      ].join(" "),
      entityKind,
      ...entries.map(([, value]) => (typeof value === "boolean" ? Number(value) : value)),
    )[0];
  return Number(row?.count ?? 0);
}

export function getEntityProjectionRow(
  db: DatabaseSync,
  entityKind: string,
  entityId: string,
): EntityProjectionRow | null {
  const row = queryRows(db, GET_ENTITY_SQL, entityKind, entityId)[0];
  if (row === undefined) return null;
  const entity = entityProjectionRow(row);
  return entityKind === "todo" ? projectEntityOrigins(db, entityKind, [entity])[0]! : entity;
}

export function deleteEntityProjectionRow(db: DatabaseSync, entityKind: string, entityId: string): void {
  runSql(
    db,
    "DELETE FROM entity_projection WHERE entity_kind = ? AND entity_id = ? AND task_id = ''",
    entityKind,
    entityId,
  );
}

export function markEntityProjectionMissing(
  db: DatabaseSync,
  entityKind: string,
  entityId: string,
  workspaceRevision: number,
): void {
  runSql(
    db,
    "UPDATE entity_projection SET workspace_revision = ?, freshness = 'orphaned', current_version = NULL " +
      "WHERE entity_kind = ? AND entity_id = ? AND task_id = '' AND workspace_revision <= ?",
    workspaceRevision,
    entityKind,
    entityId,
    workspaceRevision,
  );
}

/**
 * A declaration blob the current kind schema rejects (for example a stored pre-runtimes Agent
 * shape during the declaration-rewrite window) keeps its row, recorded as uninterpretable: the
 * rebuild continues, every read surface degrades the row instead of failing, and a newer
 * current-shape event for the same entity overwrites it through the ordinary upsert fence.
 */
export function markEntityProjectionUninterpretable(
  db: DatabaseSync,
  entityKind: string,
  entityId: string,
  workspaceRevision: number,
  value: unknown,
): void {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  runSql(db, UPSERT_ENTITY_SQL, entityKind, entityId, "", workspaceRevision, "unknown", null, canonicalJson(record));
}

function entityProjectionRow(row: Readonly<Record<string, unknown>>): EntityProjectionRow {
  const value = JSON.parse(String(row.value_json)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("entity projection value must be an object");
  return {
    kind: String(row.entity_kind),
    id: String(row.entity_id),
    ownerId: row.task_id === null || row.task_id === "" ? null : String(row.task_id),
    workspaceRevision: Number(row.workspace_revision),
    freshness: String(row.freshness) as EntityFreshness,
    currentVersion:
      typeof row.current_version === "string" || typeof row.current_version === "number" ? row.current_version : null,
    value: value as Readonly<Record<string, unknown>>,
  };
}

export function listPinnedEntityRows(db: DatabaseSync, personId?: string): readonly PinnedEntityProjectionRow[] {
  if (personId !== undefined) {
    // The import actor owned the legacy pin. Later task snapshots carry a shared flag, so
    // fold the original import revision alongside the person's explicit Pin updates.
    const rows = queryRows<{ entity_ref: string; actor_person_id: string; occurred_at: string; event_type: string }>(
      db,
      `WITH actions(entity_ref, revision) AS (
         SELECT json_extract(e.event_json, '$.payload.entityRef'), s.workspace_revision
         FROM event_summary s INDEXED BY event_summary_type_revision
         CROSS JOIN event_index e ON e.workspace_revision=s.workspace_revision
         WHERE s.actor_person_id=? AND s.event_type IN ('entity_pinned','entity_unpinned')
         UNION ALL
         SELECT 'task/' || json_extract(event_json, '$.payload.entity.task.taskId'), workspace_revision
         FROM event_index
         WHERE ${sqliteImportedTaskPinPredicate} AND json_extract(event_json,'$.actor.principal.personId')=?
       ), latest_pin AS MATERIALIZED (
         SELECT entity_ref, max(revision) AS revision FROM actions GROUP BY entity_ref
       )
       SELECT pin.entity_ref, s.actor_person_id, s.occurred_at, s.event_type
       FROM latest_pin pin
       JOIN event_summary s ON s.workspace_revision=pin.revision
       WHERE s.event_type<>'entity_unpinned' AND NOT EXISTS (
         SELECT 1 FROM event_summary_entity_ref ref
         CROSS JOIN event_summary retired ON retired.workspace_revision=ref.workspace_revision
         WHERE ref.entity_ref=pin.entity_ref AND ref.workspace_revision>pin.revision
           AND (retired.event_type IN (SELECT value FROM json_each(?))
             OR (retired.event_type='task_transitioned' AND (
               SELECT json_extract(e.event_json, '$.payload.task.status')
               FROM event_index e WHERE e.workspace_revision=ref.workspace_revision
             )='cancelled'))
       )`,
      personId,
      personId,
      JSON.stringify(pinRetirementEventTypes),
    );
    return personalPinsFromNewest(
      rows.map((row) => ({
        entityRef: row.entity_ref,
        personId: row.actor_person_id,
        pinnedAt: row.occurred_at,
        pinned: row.event_type !== "entity_unpinned",
      })),
      personId,
    );
  }
  return queryRows(
    db,
    "SELECT entity_ref, pinned_at, pinned_by FROM pinned_entities ORDER BY pinned_at DESC, entity_ref ASC",
  ).map((row) => ({
    entityRef: String(row.entity_ref),
    pinnedAt: String(row.pinned_at),
    pinnedBy: String(row.pinned_by),
  }));
}

// The entity-ref index serves both old and rebuilt caches. Resolve the first upsert, so an edit
// or completion by another collaborator never replaces the creator. The write document stays V1.
function projectEntityOrigins(
  db: DatabaseSync,
  kind: string,
  entities: readonly EntityProjectionRow[],
): readonly EntityProjectionRow[] {
  if (entities.length === 0) return entities;
  const origins = new Map(
    queryRows<{ id: string; person_id: string | null; node_id: string | null }>(
      db,
      `SELECT requested.value AS id, s.actor_person_id AS person_id, s.source_node_id AS node_id
       FROM json_each(?) requested LEFT JOIN event_summary s ON s.workspace_revision=(
         SELECT ref.workspace_revision FROM event_summary_entity_ref ref
         CROSS JOIN event_summary event ON event.workspace_revision=ref.workspace_revision
         WHERE ref.entity_ref=? || '/' || requested.value
           AND event.event_type IN ('entity_upserted','entity_reference_declared','schedule_created')
         ORDER BY ref.workspace_revision LIMIT 1
       )`,
      JSON.stringify(entities.map(({ id }) => id)),
      kind,
    ).map((row) => [row.id, row]),
  );
  return entities.map((row) => ({
    ...row,
    createdByPersonId: origins.get(row.id)?.person_id ?? null,
    originNodeId: origins.get(row.id)?.node_id ?? null,
  }));
}
