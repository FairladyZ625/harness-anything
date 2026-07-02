import { Schema } from "effect";
import { decisionStates } from "../domain/decision-lifecycle-status.ts";
import { ActorRefSchema } from "./common.ts";
import { EntityRelationRecordSchema } from "./entity-relations.ts";

const StringArray = Schema.Array(Schema.String);
const OptionalString = Schema.optional(Schema.String);
const NonBlankStringSchema = Schema.String.pipe(Schema.pattern(/\S/u));
const DecisionIdSchema = Schema.String.pipe(Schema.pattern(/^dec_[A-Za-z0-9_-]+$/u));
const AnchorIdSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9_-]*$/u));
const DecisionRiskTierSchema = Schema.Literal("low", "medium", "high");
const DecisionUrgencySchema = Schema.Literal("low", "medium", "high");

export const DecisionStateSchema = Schema.Literal(
  ...decisionStates
);

const ProvenanceEntrySchema = Schema.Struct({
  runtime: NonBlankStringSchema,
  sessionId: NonBlankStringSchema,
  boundAt: NonBlankStringSchema
});

const DecisionAnchorSchema = Schema.Struct({
  id: AnchorIdSchema,
  text: NonBlankStringSchema
});

const RejectedDecisionAnchorSchema = Schema.Struct({
  id: AnchorIdSchema,
  text: NonBlankStringSchema,
  why_not: NonBlankStringSchema
});

export const DecisionPackageSchema = Schema.Struct({
  schema: Schema.Literal("decision-package/v1"),
  decision_id: DecisionIdSchema,
  title: NonBlankStringSchema,
  state: DecisionStateSchema,
  riskTier: DecisionRiskTierSchema,
  urgency: DecisionUrgencySchema,
  vertical: NonBlankStringSchema,
  preset: NonBlankStringSchema,
  applies_to: Schema.Struct({
    modules: StringArray,
    productLines: StringArray
  }),
  proposedBy: ActorRefSchema,
  proposedAt: NonBlankStringSchema,
  arbiter: ActorRefSchema,
  decidedAt: OptionalString,
  provenance: Schema.Array(ProvenanceEntrySchema).pipe(Schema.minItems(1)),
  question: NonBlankStringSchema,
  chosen: Schema.Array(DecisionAnchorSchema).pipe(Schema.minItems(1)),
  rejected: Schema.Array(RejectedDecisionAnchorSchema).pipe(Schema.minItems(1)),
  claims: Schema.Array(DecisionAnchorSchema).pipe(Schema.minItems(1)),
  relations: Schema.Array(EntityRelationRecordSchema)
}).pipe(Schema.filter((decision) => decision.proposedBy.id !== decision.arbiter.id));

export type DecisionPackage = Schema.Schema.Type<typeof DecisionPackageSchema>;
