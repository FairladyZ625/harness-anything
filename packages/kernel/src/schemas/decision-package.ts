import { Schema } from "effect";
import { decisionStates } from "../domain/decision-lifecycle-status.ts";
import { ActorRefSchema, NonBlankStringSchema, ProvenanceEntrySchema } from "./common.ts";
import { EntityRelationRecordSchema } from "./entity-relations.ts";

const StringArray = Schema.Array(Schema.String);
const OptionalString = Schema.optional(Schema.String);
const DecisionIdSchema = Schema.String.pipe(Schema.pattern(/^dec_[A-Za-z0-9_-]+$/u));
const AnchorIdSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9_-]*$/u));
const DecisionRiskTierSchema = Schema.Literal("low", "medium", "high");
const DecisionUrgencySchema = Schema.Literal("low", "medium", "high");
const DecisionContentPinActionSchema = Schema.Literal("accept", "reject", "defer", "supersede", "retire");
const DecisionContentDigestSchema = Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/u));
export const decisionClaimFulfillments = ["evidenced", "delivered", "standing-policy"] as const;
export type DecisionClaimFulfillment = (typeof decisionClaimFulfillments)[number];

export const DecisionStateSchema = Schema.Literal(
  ...decisionStates
);

const DecisionAnchorSchema = Schema.Struct({
  id: AnchorIdSchema,
  text: NonBlankStringSchema,
  load_bearing: Schema.optional(Schema.Boolean)
});

const DecisionClaimSchema = Schema.Struct({
  id: AnchorIdSchema,
  text: NonBlankStringSchema,
  load_bearing: Schema.optional(Schema.Boolean),
  fulfillment: Schema.optional(Schema.Literal(...decisionClaimFulfillments))
});

const RejectedDecisionAnchorSchema = Schema.Struct({
  id: AnchorIdSchema,
  text: NonBlankStringSchema,
  why_not: NonBlankStringSchema
});

const DecisionContentPinSchema = Schema.Struct({
  action: DecisionContentPinActionSchema,
  state: DecisionStateSchema,
  decidedAt: NonBlankStringSchema,
  arbiter: ActorRefSchema,
  canonicalization: Schema.Literal("decision-content/v1"),
  digest: DecisionContentDigestSchema
}).pipe(Schema.filter((pin) => pin.state === contentPinState(pin.action)));

export const DecisionPackageSchema = Schema.Struct({
  schema: Schema.Literal("decision-package/v1"),
  decision_id: DecisionIdSchema,
  _coordinatorWatermark: Schema.optional(NonBlankStringSchema),
  title: NonBlankStringSchema,
  state: DecisionStateSchema,
  riskTier: DecisionRiskTierSchema,
  urgency: DecisionUrgencySchema,
  vertical: NonBlankStringSchema,
  preset: NonBlankStringSchema,
  decisionClass: Schema.optional(Schema.Literal("standing-policy")),
  applies_to: Schema.Struct({
    modules: StringArray,
    productLines: StringArray
  }),
  proposedAt: NonBlankStringSchema,
  decidedAt: OptionalString,
  contentPins: Schema.optional(Schema.Array(DecisionContentPinSchema)),
  provenance: Schema.Array(ProvenanceEntrySchema).pipe(Schema.minItems(1)),
  question: NonBlankStringSchema,
  chosen: Schema.Array(DecisionAnchorSchema).pipe(Schema.minItems(1)),
  rejected: Schema.Array(RejectedDecisionAnchorSchema).pipe(Schema.minItems(1)),
  claims: Schema.Array(DecisionClaimSchema).pipe(Schema.minItems(1)),
  relations: Schema.Array(EntityRelationRecordSchema)
});

export type DecisionPackage = Schema.Schema.Type<typeof DecisionPackageSchema>;

function contentPinState(action: typeof DecisionContentPinActionSchema.Type): typeof DecisionStateSchema.Type {
  switch (action) {
    case "accept":
      return "active";
    case "reject":
      return "rejected";
    case "defer":
      return "deferred";
    case "supersede":
    case "retire":
      return "retired";
  }
}
