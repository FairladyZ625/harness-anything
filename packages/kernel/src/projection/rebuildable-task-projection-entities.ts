// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import { runtimeSessionEntityV1, type RuntimeSession } from "../domain/agent-runtime.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import {
  deriveEntityProjection,
  interpretEmbeddedEntityProjections,
  interpretEntityValue,
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

export function deleteEntityProjectionRow(db: DatabaseSync, entityKind: string, entityId: string): void {
  runSql(db, "DELETE FROM entity_projection WHERE entity_kind = ? AND entity_id = ?", entityKind, entityId);
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
