import {
  amendableSnapshot,
  amendment,
  contentPin,
  fulfillments,
  judgmentConsent,
  proposalIssues,
  relation,
  relationId,
  validDecisionMutation,
} from "./decision-event-payload-validation.ts";
import {
  decisionEventTypes,
  decisionFulfillmentModes,
  type DecisionEventV1,
} from "./decision-event-types.ts";
import {
  claimId,
  decisionId,
  includes,
  uniqueFactStrings,
} from "./decision-event-validation-shared.ts";
import { codePoints, requiredWithOptional } from "./event-validation.ts";
import { timestamp } from "./timestamp.ts";
import {
  isNonEmptyString,
  isRecord,
  hasContractFields as matchesFields,
  serializeEventEnvelope,
  validateEventEnvelopeIdentity,
} from "./write-chain.contract.ts";

export function isDecisionEvent(event: {
  readonly schema: string;
}): event is DecisionEventV1 {
  return event.schema === "decision-event/v1";
}

export function serializeDecisionEvent(event: DecisionEventV1): string {
  const errors = validateCurrentDecisionEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return serializeEventEnvelope(event);
}

export function validateDecisionEvent(value: unknown): readonly string[] {
  return validateDecisionEventFields(value, true);
}

export function validateCurrentDecisionEvent(
  value: unknown,
): readonly string[] {
  return validateDecisionEventFields(value, false);
}

function validateDecisionEventFields(
  value: unknown,
  allowUnknownFields: boolean,
): readonly string[] {
  if (
    !isRecord(value) ||
    !matchesFields(
      value,
      [
        "schema",
        "eventId",
        "workspaceRevision",
        "opId",
        "decisionId",
        "type",
        "actor",
        "source",
        "occurredAt",
        "payload",
      ],
      allowUnknownFields,
    ) ||
    value.schema !== "decision-event/v1" ||
    !includes(decisionEventTypes, value.type) ||
    !decisionId(value.decisionId) ||
    !timestamp(value.occurredAt) ||
    !isRecord(value.payload)
  )
    return ["decision event envelope or payload is invalid"];
  if (validateEventEnvelopeIdentity(value, allowUnknownFields).length)
    return ["decision event envelope identity is invalid"];
  const payload = value.payload,
    type = value.type,
    common = ["baseDocumentSha256", "decisionDocumentClaim"],
    mutation = validDecisionMutation(
      payload,
      value.decisionId,
      type === "decision_proposed",
      allowUnknownFields,
    );
  if (!mutation) return ["decision document mutation is invalid"];
  if (type === "decision_proposed")
    return proposalIssues(
      payload,
      common,
      value.decisionId,
      allowUnknownFields,
    );
  if (type === "decision_accepted")
    return requiredWithOptional(
      payload,
      ["rationale", "judgmentOnlyRationale", "judgmentConsent", ...common],
      ["fulfillments", "standingPolicy", "contentPin"],
      allowUnknownFields,
    ) &&
      codePoints(payload.rationale, 1, 199) &&
      (payload.judgmentOnlyRationale === null ||
        codePoints(payload.judgmentOnlyRationale, 1, 199)) &&
      (payload.fulfillments === undefined ||
        fulfillments(payload.fulfillments, allowUnknownFields)) &&
      (payload.standingPolicy === undefined ||
        typeof payload.standingPolicy === "boolean") &&
      judgmentConsent(
        payload.judgmentConsent,
        value,
        type,
        allowUnknownFields,
      ) &&
      (payload.contentPin === undefined ||
        contentPin(payload.contentPin, value, allowUnknownFields))
      ? []
      : ["decision accepted payload is invalid"];
  if (type === "decision_rejected" || type === "decision_deferred")
    return requiredWithOptional(
      payload,
      ["reason", "judgmentConsent", ...common],
      ["contentPin"],
      allowUnknownFields,
    ) &&
      codePoints(payload.reason, 1, 199) &&
      judgmentConsent(
        payload.judgmentConsent,
        value,
        type,
        allowUnknownFields,
      ) &&
      (payload.contentPin === undefined ||
        contentPin(payload.contentPin, value, allowUnknownFields))
      ? []
      : [`${type} payload is invalid`];
  if (type === "decision_superseded" || type === "decision_retired")
    return requiredWithOptional(
      payload,
      ["reason", ...common],
      ["contentPin"],
      allowUnknownFields,
    ) &&
      codePoints(payload.reason, 1, 199) &&
      (payload.contentPin === undefined ||
        contentPin(payload.contentPin, value, allowUnknownFields))
      ? []
      : [`${type} payload is invalid`];
  if (type === "decision_amended")
    return matchesFields(
      payload,
      ["next", "fields", "body", "amendment", "contentPin", ...common],
      allowUnknownFields,
    ) &&
      amendableSnapshot(payload.next, allowUnknownFields) &&
      uniqueFactStrings(payload.fields) &&
      payload.fields.length > 0 &&
      (payload.body === null || typeof payload.body === "string") &&
      amendment(payload.amendment, value, allowUnknownFields) &&
      contentPin(payload.contentPin, value, allowUnknownFields)
      ? []
      : ["decision amendment payload is invalid"];
  if (type === "decision_repinned")
    return matchesFields(
      payload,
      ["migrationEvidence", "contentPin", ...common],
      allowUnknownFields,
    ) &&
      typeof payload.migrationEvidence === "string" &&
      /^task\/[^/]+\/[^/]+$/u.test(payload.migrationEvidence) &&
      contentPin(payload.contentPin, value, allowUnknownFields)
      ? []
      : ["decision repin payload is invalid"];
  if (type === "decision_claim_declared")
    return matchesFields(
      payload,
      ["claimId", "text", "loadBearing", ...common],
      allowUnknownFields,
    ) &&
      claimId(payload.claimId) &&
      isNonEmptyString(payload.text) &&
      typeof payload.loadBearing === "boolean"
      ? []
      : ["decision claim payload is invalid"];
  if (type === "decision_claim_fulfillment_declared")
    return matchesFields(
      payload,
      ["claimId", "mode", ...common],
      allowUnknownFields,
    ) &&
      claimId(payload.claimId) &&
      includes(decisionFulfillmentModes, payload.mode)
      ? []
      : ["decision fulfillment payload is invalid"];
  if (type === "decision_related")
    return matchesFields(
      payload,
      ["relation", ...common],
      allowUnknownFields,
    ) && relation(payload.relation, allowUnknownFields)
      ? []
      : ["decision relation payload is invalid"];
  if (type === "decision_relation_replaced")
    return matchesFields(
      payload,
      ["relationId", "reason", "replacement", "body", ...common],
      allowUnknownFields,
    ) &&
      relationId(payload.relationId) &&
      codePoints(payload.reason, 1, 199) &&
      relation(payload.replacement, allowUnknownFields) &&
      (payload.body === null || typeof payload.body === "string")
      ? []
      : ["decision relation replacement payload is invalid"];
  return matchesFields(
    payload,
    ["relationId", "reason", ...common],
    allowUnknownFields,
  ) &&
    relationId(payload.relationId) &&
    codePoints(payload.reason, 1, 199)
    ? []
    : ["decision relation retirement payload is invalid"];
}
