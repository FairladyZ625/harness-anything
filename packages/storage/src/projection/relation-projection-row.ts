import type { VersionedRelationProjectionRow } from "@harness-anything/kernel";
import type { EntityVersion, RelationFreshness } from "@harness-anything/kernel/internal/domain/entity-freshness.ts";
import { relationOwnerRef } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import type { RelationEntity } from "@harness-anything/kernel/internal/domain/relation-event.ts";

export const RELATION_PROJECTION_VERSION = "relation-projection/v1" as const;

/** One relation row shape shared by the native SQLite and PostgreSQL readers. */
export function relationProjectionRowFromColumns(
  entity: RelationEntity,
  sourcePath: string,
  columns: { readonly freshness: RelationFreshness; readonly currentTargetVersion: EntityVersion | null },
): VersionedRelationProjectionRow {
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
    targetObservedVersion: entity.targetObservedVersion,
    currentTargetVersion: columns.currentTargetVersion,
    freshness: columns.freshness,
    rationale: entity.rationale,
    ownerRef: relationOwnerRef(entity.source),
    sourcePath,
    recordIndex: 0,
  });
}
