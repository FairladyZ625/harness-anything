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
import { canonicalJson, runSql } from "./rebuildable-task-projection-sql.ts";

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
