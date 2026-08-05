import {
  decisionAmendableFields,
  decisionAmendOperations,
  type DecisionAmendField,
  type DecisionAmendOperation
} from "@harness-anything/kernel";
import {
  strictArray,
  strictBoolean,
  strictEnum,
  strictLiteral,
  strictObject,
  strictString,
  type StrictSchema
} from "./strict-command-schema.ts";

const strings = strictArray(strictString);
const confidence = strictEnum("low", "medium", "high");
const fulfillment = strictEnum("evidenced", "delivered", "standing-policy");
const relationType = strictEnum(
  "supports", "supersedes", "refines", "narrows", "derives", "blocks",
  "relates", "implements", "depends-on", "produces", "evidences",
  "evidenced-by", "refutes", "invalidated-by", "supersedes-fact"
);
const memoryClass = strictEnum("semantic", "episodic", "procedural");
const memoryTag = strictEnum(
  "episode", "procedural", "tool_memory", "pattern", "task_skill",
  "abstract_rule", "other"
);

const choice = strictObject({
  text: strictString
}, {
  id: strictString,
  load_bearing: strictBoolean
});

const rejected = strictObject({
  text: strictString
}, {
  id: strictString,
  why_not: strictString
});

const claim = strictObject({
  text: strictString
}, {
  id: strictString,
  load_bearing: strictBoolean,
  fulfillment
});

const claimFulfillment = strictObject({
  claimId: strictString,
  fulfillment
});

const evidenceRelation = strictObject({
  anchor: strictString,
  type: relationType,
  target: strictString,
  rationale: strictString
});

// The amendable field and operation vocabularies are owned by the kernel field
// contracts; deriving the wire enums from them keeps this schema from drifting.
const amendField: StrictSchema<DecisionAmendField> = strictEnum(...decisionAmendableFields);
const amendOperation: StrictSchema<DecisionAmendOperation> = strictEnum(...decisionAmendOperations);
const amendPatch = strictObject({
  field: amendField,
  operation: amendOperation,
  value: strictString
});

export const repoWriteKnowledgeActionSchemas = {
  "decision-repin": strictObject({
    kind: strictLiteral("decision-repin"),
    decisionId: strictString,
    migrationEvidence: strictString
  }),
  "decision-propose": strictObject({
    kind: strictLiteral("decision-propose"),
    decisionId: strictString,
    proposedAt: strictString,
    title: strictString,
    question: strictString,
    chosen: strictArray(choice),
    rejected: strictArray(rejected),
    claims: strictArray(claim),
    claimLoadBearing: strictBoolean,
    fulfillments: strictArray(claimFulfillment),
    riskTier: confidence,
    urgency: confidence,
    modules: strings,
    productLines: strings,
    evidenceRelations: strictArray(evidenceRelation),
    dryRun: strictBoolean
  }, {
    decisionIdProvided: strictBoolean,
    claim: strictString,
    surfaces: strings,
    body: strictString
  }),
  "decision-transition": strictObject({
    kind: strictLiteral("decision-transition"),
    transition: strictEnum("accept", "reject", "defer", "supersede", "retire"),
    decisionId: strictString,
    fulfillments: strictArray(claimFulfillment),
    dryRun: strictBoolean
  }, {
    decidedAt: strictString,
    judgmentOnlyRationale: strictString,
    standingPolicy: strictBoolean,
    body: strictString
  }),
  "decision-reckon": strictObject({
    kind: strictLiteral("decision-reckon"),
    decisionId: strictString,
    taskId: strictString,
    dryRun: strictBoolean
  }),
  "decision-amend": strictObject({
    kind: strictLiteral("decision-amend"),
    decisionId: strictString,
    fulfillments: strictArray(claimFulfillment),
    patches: strictArray(amendPatch),
    dryRun: strictBoolean
  }, {
    title: strictString,
    standingPolicy: strictBoolean,
    body: strictString
  }),
  "decision-relate": strictObject({
    kind: strictLiteral("decision-relate"),
    decisionId: strictString,
    anchor: strictString,
    relationType,
    target: strictString,
    rationale: strictString,
    dryRun: strictBoolean
  }, {
    body: strictString
  }),
  "decision-relation-retire": strictObject({
    kind: strictLiteral("decision-relation-retire"),
    decisionId: strictString,
    relationId: strictString,
    dryRun: strictBoolean
  }, {
    body: strictString
  }),
  "decision-relation-replace": strictObject({
    kind: strictLiteral("decision-relation-replace"),
    decisionId: strictString,
    relationId: strictString,
    anchor: strictString,
    relationType,
    target: strictString,
    rationale: strictString,
    dryRun: strictBoolean
  }, {
    body: strictString
  }),
  "record-fact": strictObject({
    kind: strictLiteral("record-fact"),
    taskId: strictString,
    factId: strictString,
    statement: strictString,
    observedAt: strictString,
    confidence,
    memoryClass,
    memoryTags: strictArray(memoryTag),
    dryRun: strictBoolean
  }, {
    factIdProvided: strictBoolean,
    source: strictString
  }),
  "fact-invalidate": strictObject({
    kind: strictLiteral("fact-invalidate"),
    taskId: strictString,
    factId: strictString,
    invalidatedByFactId: strictString,
    rationale: strictString,
    dryRun: strictBoolean
  }),
  "distill-candidate": strictObject({
    kind: strictLiteral("distill-candidate"),
    taskId: strictString,
    inputPath: strictString
  }),
  "distill-commit": strictObject({
    kind: strictLiteral("distill-commit"),
    taskId: strictString,
    candidatePath: strictString,
    claim: strictString,
    confidence,
    memoryClass,
    memoryTags: strictArray(memoryTag)
  }, {
    factId: strictString,
    observedAt: strictString
  })
} as const;
