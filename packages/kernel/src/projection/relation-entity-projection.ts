// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import type { DecisionEventV1 } from "../domain/decision-event.ts";
import type { FactEventV1 } from "../domain/fact-event.ts";
import { entityKindContracts } from "../domain/entity-kind-registry.ts";
import { interpretEmbeddedEntityProjections } from "../domain/entity-kind-projection.ts";
import { relationOwnerRef, type EntityRelationRecord } from "../domain/entity-relation.ts";
import type { TaskEventV1 } from "../domain/task-lifecycle-event.ts";
import {
  assertRelationRecord,
  embeddedRelationEventsForReplay,
  reduceRelationEntity,
  relationRecord,
  type RelationEntity,
  type RelationEventV1,
} from "../domain/relation-event.ts";
import type { MigrationImportEventV1 } from "../domain/migration-import-event.ts";
import type { RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { canonicalJson, queryRow, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
import { refreshTaskRelationProjection } from "./task-query-projection.ts";

export const RELATION_PROJECTION_VERSION = "relation-projection/v1" as const;

export interface VersionedRelationProjectionRow extends RelationGraphEdgeRow {
  readonly schema: typeof RELATION_PROJECTION_VERSION;
  readonly entity: RelationEntity;
  readonly workspaceRevision: number;
}

export function applyRelationProjectionEvent(
  db: DatabaseSync,
  event: RelationEventV1 | MigrationImportEventV1,
): VersionedRelationProjectionRow {
  const migration = event.schema === "migration-import-event/v1" ? event.payload.entity : null;
  if (migration !== null && migration.kind !== "relation") throw new Error("Relation projection received another kind");
  const relationId =
      migration?.kind === "relation" ? migration.relation.relation_id : (event as RelationEventV1).relationId,
    current = readRelationProjectionRow(db, relationId),
    entity = reduceRelationEntity(current?.entity ?? null, event),
    row = relationProjectionRow(entity, `event:${event.opId}`);
  runSql(
    db,
    [
      "INSERT INTO relation_edge(relation_id, source_ref, target_ref, relation_type, " +
        "state, owner_ref, workspace_revision, row_json)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT(relation_id) DO UPDATE SET source_ref=excluded.source_ref, target_ref=excluded.target_ref,",
      "relation_type=excluded.relation_type, state=excluded.state, owner_ref=excluded.owner_ref,",
      "workspace_revision=excluded.workspace_revision, row_json=excluded.row_json",
      "WHERE relation_edge.workspace_revision < excluded.workspace_revision",
    ].join(" "),
    row.relationId,
    row.sourceRef,
    row.targetRef,
    row.relationType,
    row.state,
    row.ownerRef,
    row.workspaceRevision,
    canonicalJson(row),
  );
  const taskId = row.sourceRef.match(/^task\/([^/]+)$/u)?.[1];
  const taskRelationReady = queryRow(
    db,
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='task_relation'",
  );
  if (taskId && taskRelationReady)
    refreshTaskRelationProjection(db, taskId, null, row.workspaceRevision, entity.updatedAt);
  return row;
}

export function applyEmbeddedRelationProjectionEvents(
  db: DatabaseSync,
  event: DecisionEventV1 | FactEventV1 | TaskEventV1,
): void {
  for (const relationEvent of embeddedRelationEventsForReplay(event)) applyRelationProjectionEvent(db, relationEvent);
  for (const contract of entityKindContracts)
    for (const projection of interpretEmbeddedEntityProjections(contract, event))
      for (const relation of projection.relations) {
        const record = {
          relation_id: relation.relationId,
          source: relation.sourceRef,
          target: relation.targetRef,
          type: relation.relationType,
          direction: relation.direction,
          strength: relation.strength,
          origin: relation.origin,
          state: relation.state,
          rationale: relation.rationale,
        } as EntityRelationRecord;
        assertRelationRecord(record);
        const current = readRelationProjectionRow(db, record.relation_id);
        if (current === null)
          applyRelationProjectionEvent(db, {
            schema: "relation-event/v1",
            eventId: event.eventId,
            workspaceRevision: event.workspaceRevision,
            opId: event.opId,
            relationId: record.relation_id,
            type: "relation_created",
            actor: event.actor,
            source: event.source,
            occurredAt: event.occurredAt,
            payload: { relation: record },
          });
        else if (canonicalJson(relationRecord(current.entity)) !== canonicalJson(record))
          throw new Error(`Embedded relation ${record.relation_id} changed identity`);
      }
}

export function readRelationProjectionRow(db: DatabaseSync, relationId: string): VersionedRelationProjectionRow | null {
  const selected = queryRow<{ readonly row_json: string }>(
    db,
    "SELECT row_json FROM relation_edge WHERE relation_id=?",
    relationId,
  );
  if (!selected) return null;
  const value = JSON.parse(selected.row_json) as Partial<VersionedRelationProjectionRow>;
  return value.schema === RELATION_PROJECTION_VERSION && value.entity?.kind === "relation"
    ? (value as VersionedRelationProjectionRow)
    : null;
}

export function readRelationProjectionRows(db: DatabaseSync): readonly VersionedRelationProjectionRow[] {
  return queryRows<{ readonly row_json: string }>(db, "SELECT row_json FROM relation_edge ORDER BY relation_id")
    .map((row) => JSON.parse(row.row_json) as Partial<VersionedRelationProjectionRow>)
    .filter(
      (row): row is VersionedRelationProjectionRow =>
        row.schema === RELATION_PROJECTION_VERSION && row.entity?.kind === "relation",
    );
}

export function relationProjectionRow(entity: RelationEntity, sourcePath: string): VersionedRelationProjectionRow {
  return Object.freeze({
    schema: RELATION_PROJECTION_VERSION,
    entity,
    workspaceRevision: entity.revision,
    relationId: entity.id,
    sourceRef: entity.source,
    targetRef: entity.target,
    relationType: entity.type,
    direction: entity.direction,
    strength: entity.strength,
    origin: entity.origin,
    state: entity.state,
    rationale: entity.rationale,
    ownerRef: relationOwnerRef(entity.source),
    sourcePath,
    recordIndex: 0,
  });
}
