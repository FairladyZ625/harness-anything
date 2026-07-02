import { Schema } from "effect";
import {
  deriveRelationId,
  relationDirections,
  relationOrigins,
  relationStates,
  relationStrengths,
  relationTypes,
  validateRelationRecordsForHost
} from "../domain/entity-relation.ts";

const NonBlankStringSchema = Schema.String.pipe(Schema.pattern(/\S/u));
const RelationIdSchema = Schema.String.pipe(Schema.pattern(/^rel_[a-f0-9]{16}$/u));
const EntityRelationRefSchema = Schema.String.pipe(
  Schema.pattern(/^(?:(?:task|decision)\/[A-Za-z0-9_-]+(?:\/[A-Za-z][A-Za-z0-9_-]*)?|fact\/[A-Za-z0-9_-]+\/F-[A-Za-z0-9_-]+)$/u)
);

export const RelationTypeSchema = Schema.Literal(...relationTypes);
export const RelationStrengthSchema = Schema.Literal(...relationStrengths);
export const RelationDirectionSchema = Schema.Literal(...relationDirections);
export const RelationOriginSchema = Schema.Literal(...relationOrigins);
export const RelationStateSchema = Schema.Literal(...relationStates);

export const EntityRelationRecordSchema = Schema.Struct({
  relation_id: RelationIdSchema,
  source: EntityRelationRefSchema,
  target: EntityRelationRefSchema,
  type: RelationTypeSchema,
  strength: RelationStrengthSchema,
  direction: RelationDirectionSchema,
  origin: RelationOriginSchema,
  rationale: NonBlankStringSchema,
  state: RelationStateSchema
}).pipe(Schema.filter((record) => record.relation_id === deriveRelationId(record)));

export const EntityRelationsSchema = Schema.Struct({
  schema: Schema.Literal("entity-relations/v1"),
  host: EntityRelationRefSchema,
  relations: Schema.Array(EntityRelationRecordSchema)
}).pipe(Schema.filter((document) => validateRelationRecordsForHost(document.host, document.relations).length === 0));

export type EntityRelationRecord = Schema.Schema.Type<typeof EntityRelationRecordSchema>;
export type EntityRelations = Schema.Schema.Type<typeof EntityRelationsSchema>;
