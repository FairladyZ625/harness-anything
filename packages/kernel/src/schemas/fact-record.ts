import { Schema } from "effect";
import { factConfidenceLevels } from "../domain/fact-record.ts";

const NonBlankStringSchema = Schema.String.pipe(Schema.pattern(/\S/u));
const FactIdSchema = Schema.String.pipe(Schema.pattern(/^F-[0-9A-HJKMNP-TV-Z]{8}$/u));
const ProvenanceEntrySchema = Schema.Struct({
  runtime: NonBlankStringSchema,
  sessionId: NonBlankStringSchema,
  boundAt: NonBlankStringSchema
});

export const FactRecordSchema = Schema.Struct({
  schema: Schema.Literal("fact-record/v1"),
  fact_id: FactIdSchema,
  statement: NonBlankStringSchema,
  source: NonBlankStringSchema,
  observedAt: NonBlankStringSchema,
  confidence: Schema.Literal(...factConfidenceLevels),
  provenance: Schema.Array(ProvenanceEntrySchema).pipe(Schema.minItems(1))
});

export type FactRecordDocument = Schema.Schema.Type<typeof FactRecordSchema>;
