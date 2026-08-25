// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import {
  deriveEntityProjection,
  interpretEmbeddedEntityProjections,
  type InterpretedEntityValue,
  type InterpretedEntityProjection,
} from "../domain/entity-kind-projection.ts";
import { entityKindContracts, type EntityKindContract } from "../domain/entity-kind-registry.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
import type { EntityProjectionRow } from "./task-projection-port.ts";

const UPSERT_ENTITY_SQL = [
  "INSERT INTO entity_projection(entity_kind, entity_id, task_id, workspace_revision, value_json)",
  "VALUES (?, ?, ?, ?, ?) ON CONFLICT(entity_kind, entity_id) DO UPDATE SET",
  "task_id=excluded.task_id, workspace_revision=excluded.workspace_revision, value_json=excluded.value_json",
  "WHERE entity_projection.workspace_revision <= excluded.workspace_revision",
].join(" ");
const UPSERT_RELATION_SQL = [
  "INSERT INTO relation_edge(relation_id, source_ref, target_ref, relation_type, state, owner_ref,",
  "workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  "ON CONFLICT(relation_id) DO UPDATE SET source_ref=excluded.source_ref, target_ref=excluded.target_ref,",
  "relation_type=excluded.relation_type, state=excluded.state, owner_ref=excluded.owner_ref,",
  "workspace_revision=excluded.workspace_revision, row_json=excluded.row_json",
  "WHERE relation_edge.workspace_revision <= excluded.workspace_revision",
].join(" ");
const LIST_ENTITY_SQL = [
  "SELECT entity_kind, entity_id, task_id, workspace_revision, value_json FROM entity_projection",
  "WHERE entity_kind = ? ORDER BY entity_id",
].join(" ");
const GET_ENTITY_SQL = [
  "SELECT entity_kind, entity_id, task_id, workspace_revision, value_json FROM entity_projection",
  "WHERE entity_kind = ? AND entity_id = ? LIMIT 1",
].join(" ");

export function projectEmbeddedCanonicalEntities(db: DatabaseSync, event: CanonicalEventV1): void {
  for (const contract of entityKindContracts)
    for (const projection of interpretEmbeddedEntityProjections(contract, event)) writeEntityProjection(db, projection);
}

export function projectInterpretedEntityValue(
  db: DatabaseSync,
  contract: EntityKindContract,
  entity: InterpretedEntityValue,
  workspaceRevision: number,
  sourcePath: string,
): InterpretedEntityProjection | null {
  const projection = deriveEntityProjection(contract, entity, workspaceRevision, sourcePath);
  if (projection !== null) writeEntityProjection(db, projection);
  return projection;
}

function writeEntityProjection(db: DatabaseSync, projection: InterpretedEntityProjection): void {
  runSql(
    db,
    UPSERT_ENTITY_SQL,
    projection.kind,
    projection.id,
    projection.ownerId,
    projection.workspaceRevision,
    canonicalJson(projection.value),
  );
  for (const relation of projection.relations)
    runSql(
      db,
      UPSERT_RELATION_SQL,
      relation.relationId,
      relation.sourceRef,
      relation.targetRef,
      relation.relationType,
      relation.state,
      relation.ownerRef,
      projection.workspaceRevision,
      canonicalJson(relation),
    );
}

export function listEntityProjectionRows(db: DatabaseSync, entityKind: string): readonly EntityProjectionRow[] {
  return queryRows(db, LIST_ENTITY_SQL, entityKind).map(entityProjectionRow);
}

export function getEntityProjectionRow(
  db: DatabaseSync,
  entityKind: string,
  entityId: string,
): EntityProjectionRow | null {
  const row = queryRows(db, GET_ENTITY_SQL, entityKind, entityId)[0];
  return row === undefined ? null : entityProjectionRow(row);
}

function entityProjectionRow(row: Readonly<Record<string, unknown>>): EntityProjectionRow {
  const value = JSON.parse(String(row.value_json)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("entity projection value must be an object");
  return {
    kind: String(row.entity_kind),
    id: String(row.entity_id),
    ownerId: row.task_id === null ? null : String(row.task_id),
    workspaceRevision: Number(row.workspace_revision),
    value: value as Readonly<Record<string, unknown>>,
  };
}
