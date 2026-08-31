import { deriveRelationId, type EntityRelationRecord } from "../domain/entity-relation.ts";
import type { MigrationImportEventV1 } from "../domain/migration-import-event.ts";

export function normalizeLegacyRelationRecord(
  record: EntityRelationRecord,
  legacyFactRefs: ReadonlyMap<string, string>,
  legacyRelationIds?: Map<string, string>,
): EntityRelationRecord {
  const source = legacyFactRefs.get(record.source) ?? record.source,
    target = legacyFactRefs.get(record.target) ?? record.target;
  if (source === record.source && target === record.target) return record;
  const relation_id = deriveRelationId({ source, target, type: record.type, direction: record.direction });
  legacyRelationIds?.set(record.relation_id, relation_id);
  return { ...record, source, target, relation_id };
}

export function normalizeLegacyRelationMigrationEvent(
  event: MigrationImportEventV1,
  legacyFactRefs: ReadonlyMap<string, string>,
  legacyRelationIds: Map<string, string>,
): MigrationImportEventV1 {
  if (event.payload.entity.kind !== "relation") return event;
  const relation = normalizeLegacyRelationRecord(event.payload.entity.relation, legacyFactRefs, legacyRelationIds);
  return relation === event.payload.entity.relation
    ? event
    : { ...event, payload: { ...event.payload, entity: { ...event.payload.entity, relation } } };
}
