import type { DecisionEventDraftV1 } from "./decision-event-types.ts";
/** Public Decision event contract. */
export * from "./decision-event-types.ts";
export {
  assertDecisionAcceptReview,
  assertDecisionReviewMutation,
  assertDecisionContentPin,
  assertDecisionJudgmentConsent,
  assertDecisionWritePlan,
  compileDecisionWrite,
  decisionDocumentProse,
  decisionMachineDigest,
  decisionAcceptReviewReadiness,
  decisionReviewContentDigest,
  decisionWritePlan,
  reduceDecisionDocument,
  renderDecisionDocument,
} from "./decision-event-document.ts";
export type {
  DecisionAcceptReviewReadiness,
  DecisionRelationLinkResolver,
  DecisionRelationLinkTarget,
} from "./decision-event-document.ts";
export { isDecisionEvent, validateCurrentDecisionEvent, validateDecisionEvent } from "./decision-event-validation.ts";

export function createDecisionEvent<T extends DecisionEventDraftV1["type"]>(
  identity: Omit<DecisionEventDraftV1, "schema" | "type" | "payload">,
  type: T,
  payload: Extract<DecisionEventDraftV1, { readonly type: T }>["payload"],
): Extract<DecisionEventDraftV1, { readonly type: T }> {
  return { ...identity, schema: "decision-event/v1", type, payload } as Extract<
    DecisionEventDraftV1,
    { readonly type: T }
  >;
}
