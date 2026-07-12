import { Schema } from "effect";
import { factConfidenceLevels, factMemoryClasses, factMemoryTags } from "../domain/fact-record.ts";
import { NonBlankStringSchema, ProvenanceEntrySchema } from "./common.ts";

const FactIdSchema = Schema.String.pipe(Schema.pattern(/^F-[0-9A-HJKMNP-TV-Z]{8}$/u));

export const FactRecordSchema = Schema.Struct({
  schema: Schema.Literal("fact-record/v1"),
  fact_id: FactIdSchema,
  statement: NonBlankStringSchema,
  source: NonBlankStringSchema,
  observedAt: NonBlankStringSchema,
  confidence: Schema.Literal(...factConfidenceLevels),
  memoryClass: Schema.Literal(...factMemoryClasses),
  memoryTags: Schema.Array(Schema.Literal(...factMemoryTags)),
  provenance: Schema.Array(ProvenanceEntrySchema).pipe(Schema.minItems(1)),
  migration: Schema.optional(Schema.Struct({
    schema: Schema.Literal("fact-migration/v1"),
    state: Schema.Literal("migrated"),
    plan_id: NonBlankStringSchema,
    execution_ref: NonBlankStringSchema,
    evidence_id: NonBlankStringSchema,
    migrated_at: NonBlankStringSchema
  }))
});

export type FactRecordDocument = Schema.Schema.Type<typeof FactRecordSchema>;
