import { Schema } from "effect";
import { decisionStates } from "../domain/decision-lifecycle-status.ts";
import { ActorRefSchema } from "./common.ts";

const StringArray = Schema.Array(Schema.String);
const OptionalString = Schema.optional(Schema.String);
const NonBlankStringSchema = Schema.String.pipe(Schema.pattern(/\S/u));
const DecisionIdSchema = Schema.String.pipe(Schema.pattern(/^dec_[A-Za-z0-9_-]+$/u));
const AnchorIdSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9_-]*$/u));
const EntityRefStringSchema = Schema.String.pipe(Schema.pattern(/^(?:task|decision|fact)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/u));
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

const DecisionRelationRecordSchema = Schema.Struct({
  relation_id: Schema.String.pipe(Schema.pattern(/^rel_[A-Za-z0-9_-]+$/u)),
  source: EntityRefStringSchema,
  target: EntityRefStringSchema,
  type: NonBlankStringSchema,
  strength: Schema.Literal("strong", "weak"),
  direction: Schema.Literal("directed", "undirected"),
  origin: Schema.Literal("declared", "imported_snapshot", "generated", "inferred"),
  rationale: NonBlankStringSchema,
  state: Schema.Literal("active", "deprecated", "deleted")
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
  relations: Schema.Array(DecisionRelationRecordSchema)
}).pipe(Schema.filter((decision) => decision.proposedBy.id !== decision.arbiter.id));

export type DecisionPackage = Schema.Schema.Type<typeof DecisionPackageSchema>;
