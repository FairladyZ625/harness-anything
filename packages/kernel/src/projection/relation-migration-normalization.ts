import {
  deriveRelationId,
  isAllowedRelationKindTriple,
  type EntityRelationRecord,
  type RelationType,
} from "../domain/entity-relation.ts";
import { parseEntityRef } from "../domain/entity-ref.ts";
import type { MigrationImportEventV1 } from "../domain/migration-import-event.ts";

const legacyRelationTypeMappings = new Map<string, RelationType>([
  ["decision\0implements\0task", "derives"],
  ["decision\0refines\0fact", "evidenced-by"],
  ["decision\0supports\0fact", "evidenced-by"],
  ["decision\0supports\0task", "relates"],
]);

function normalizeLegacyRelationType(record: EntityRelationRecord): RelationType {
  const source = parseEntityRef(record.source),
    target = parseEntityRef(record.target);
  if (!source || !target) return record.type;
  return legacyRelationTypeMappings.get(`${source.kind}\0${record.type}\0${target.kind}`) ?? record.type;
}

export function legacyRelationManualReason(record: EntityRelationRecord): string | null {
  const source = parseEntityRef(record.source),
    target = parseEntityRef(record.target);
  return source &&
    target &&
    !source.externalHarness &&
    !target.externalHarness &&
    !isAllowedRelationKindTriple(source.kind, record.type, target.kind)
    ? [
        "manual adjudication required: no deterministic legacy mapping for ",
        `${source.kind} --${record.type}--> ${target.kind}`,
      ].join("")
    : null;
}

export function normalizeLegacyRelationRecord(
  record: EntityRelationRecord,
  legacyFactRefs: ReadonlyMap<string, string>,
  legacyRelationIds?: Map<string, string>,
): EntityRelationRecord {
  const source = legacyFactRefs.get(record.source) ?? record.source,
    target = legacyFactRefs.get(record.target) ?? record.target,
    type = normalizeLegacyRelationType({ ...record, source, target });
  if (source === record.source && target === record.target && type === record.type) return record;
  const relation_id = deriveRelationId({ source, target, type, direction: record.direction });
  legacyRelationIds?.set(record.relation_id, relation_id);
  return { ...record, source, target, type, relation_id };
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
