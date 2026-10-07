import type { DatabaseSync } from "node:sqlite";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { isEntityEvent } from "../domain/entity-event.ts";
import { reduceArtifactEntityState, type ArtifactEntityState } from "../domain/artifact-entity-state.ts";
import { canonicalJson, queryRow, runSql } from "./rebuildable-task-projection-sql.ts";

export function readArtifactEntityState(db: DatabaseSync, kind: string, id: string): ArtifactEntityState | null {
  const row = queryRow(
    db,
    "SELECT state_json FROM artifact_entity_state WHERE entity_kind = ? AND entity_id = ?",
    kind,
    id,
  );
  return row ? (JSON.parse(String(row.state_json)) as ArtifactEntityState) : null;
}

export function projectArtifactEntityState(db: DatabaseSync, event: PersistedCanonicalEventV1): void {
  if (!isEntityEvent(event)) return;
  const { entityKind, entityId } = event.payload;
  const state = reduceArtifactEntityState(readArtifactEntityState(db, entityKind, entityId), event);
  runSql(
    db,
    "INSERT OR REPLACE INTO artifact_entity_state(entity_kind, entity_id, state_json) VALUES (?, ?, ?)",
    entityKind,
    entityId,
    canonicalJson(state),
  );
}
