import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import {
  validateSessionIdentity,
  validateSessionProvenance,
} from "./agent-runtime.ts";
import { outcomeState } from "./decision-event-document.ts";
import {
  DECISION_DOCUMENT_POLICY_ID,
  decisionFulfillmentModes,
  decisionStates,
  type DecisionAmendableSnapshot,
  type DecisionAmendmentV1,
  type DecisionContentPinV1,
  type DecisionJudgmentConsentV1,
  type DecisionOutcomeType,
} from "./decision-event-types.ts";
import {
  claimId,
  includes,
  optionId,
  uniqueFactStrings,
} from "./decision-event-validation-shared.ts";
import {
  deriveRelationId,
  relationDirections,
  relationOrigins,
  relationStates,
  relationStrengths,
  relationTypes,
  type EntityRelationRecord,
} from "./entity-relation.ts";
import { codePoints, requiredWithOptional } from "./event-validation.ts";
import { timestamp } from "./timestamp.ts";
import {
  isNonEmptyString,
  isRecord,
  hasContractFields as matchesFields,
  sameActorIdentity,
  sameWriteSource,
  validateActorIdentity,
  validateWriteSource,
} from "./write-chain.contract.ts";

export function proposalIssues(
  value: Readonly<Record<string, unknown>>,
  common: readonly string[] = [],
  id?: unknown,
  allowUnknownFields = false,
): readonly string[] {
  const legacyFields = [
      "title",
      "question",
      "riskTier",
      "urgency",
      "vertical",
      "preset",
      "appliesTo",
      "decisionClass",
      "chosen",
      "rejected",
      "body",
      "claims",
      "fulfillments",
      "relations",
    ],
    fields = [...legacyFields, "provenance"];
  if (
    !(allowUnknownFields
      ? requiredWithOptional(
          value,
          [...legacyFields, ...common],
          ["provenance"],
          true,
        )
      : matchesFields(value, [...fields, ...common], false))
  )
    return [`decision proposal requires exactly: ${fields.join(", ")}`];
  const issues: string[] = [],
    check = (ok: boolean, message: string): void => {
      if (!ok) issues.push(message);
    };
  check(
    codePoints(value.question, 1, 499),
    "question must be 1..499 code points",
  );
  for (const field of ["riskTier", "urgency"] as const)
    check(
      includes(["low", "medium", "high"] as const, value[field]),
      `${field} must be low, medium, or high`,
    );
  for (const field of ["title", "vertical", "preset"] as const)
    check(
      isNonEmptyString(value[field]),
      `${field} must be a non-empty string`,
    );
  check(
    includes(["ordinary", "standing_policy"] as const, value.decisionClass),
    "decisionClass must be ordinary or standing_policy",
  );
  check(
    isRecord(value.appliesTo) &&
      matchesFields(
        value.appliesTo,
        ["modules", "productLines"],
        allowUnknownFields,
      ) &&
      uniqueFactStrings(value.appliesTo.modules) &&
      uniqueFactStrings(value.appliesTo.productLines),
    "appliesTo must carry exactly modules and productLines as arrays of unique non-empty strings",
  );
  check(typeof value.body === "string", "body must be a string");
  for (const field of ["chosen", "rejected"] as const)
    check(
      Array.isArray(value[field]) && value[field].length > 0,
      `${field} must be a non-empty array`,
    );
  for (const field of ["claims", "fulfillments", "relations"] as const)
    check(Array.isArray(value[field]), `${field} must be an array`);
  check(
    (allowUnknownFields && value.provenance === undefined) ||
      (Array.isArray(value.provenance) &&
        value.provenance.length === 1 &&
        value.provenance.every((entry) =>
          sessionProvenanceValue(entry, allowUnknownFields),
        )),
    "provenance must contain exactly one session identity",
  );
  if (issues.length) return issues;
  const chosen = value.chosen as readonly unknown[],
    rejected = value.rejected as readonly unknown[],
    claims = value.claims as readonly unknown[],
    fulfilled = value.fulfillments as readonly unknown[],
    relations = value.relations as readonly unknown[];
  check(
    chosen.every(
      (entry) =>
        isRecord(entry) &&
        requiredWithOptional(
          entry,
          ["id", "text"],
          ["rationale"],
          allowUnknownFields,
        ) &&
        optionId(entry.id, "CH") &&
        isNonEmptyString(entry.text) &&
        (entry.rationale === undefined || codePoints(entry.rationale, 1, 199)),
    ),
    "every chosen entry needs a CH id, non-empty text, and an optional 1..199 rationale",
  );
  check(
    rejected.every(
      (entry) =>
        isRecord(entry) &&
        matchesFields(entry, ["id", "text", "whyNot"], allowUnknownFields) &&
        optionId(entry.id, "RJ") &&
        isNonEmptyString(entry.text) &&
        codePoints(entry.whyNot, 1, 199),
    ),
    "every rejected entry needs an RJ id, non-empty text, and a 1..199 whyNot",
  );
  check(
    claims.every(
      (entry) =>
        isRecord(entry) &&
        matchesFields(
          entry,
          ["id", "text", "loadBearing"],
          allowUnknownFields,
        ) &&
        claimId(entry.id) &&
        isNonEmptyString(entry.text) &&
        typeof entry.loadBearing === "boolean",
    ),
    "every claim needs a C id, non-empty text, and a boolean loadBearing",
  );
  check(
    fulfilled.every(
      (entry) =>
        isRecord(entry) &&
        matchesFields(entry, ["claimId", "mode"], allowUnknownFields) &&
        claimId(entry.claimId) &&
        includes(decisionFulfillmentModes, entry.mode),
    ),
    `every fulfillment needs a claimId and a mode of ${decisionFulfillmentModes.join(", ")}`,
  );
  const ids = [...chosen, ...rejected, ...claims].map((entry) =>
      isRecord(entry) ? String(entry.id) : "",
    ),
    claimIds = new Set(
      claims.map((entry) => (isRecord(entry) ? entry.id : null)),
    ),
    fulfillmentIds = fulfilled.map((entry) =>
      isRecord(entry) ? entry.claimId : null,
    ),
    relationIds = relations.map((entry) =>
      isRecord(entry) ? entry.relation_id : null,
    ),
    anchored = new Set(ids);
  check(
    new Set(ids).size === ids.length,
    "chosen, rejected, and claim ids must be unique across the packet",
  );
  check(
    new Set(fulfillmentIds).size === fulfillmentIds.length &&
      fulfillmentIds.every((entry) => claimIds.has(entry)),
    "every fulfillment must name a distinct claim declared in this packet",
  );
  check(
    relations.every(
      (entry) =>
        relation(entry, allowUnknownFields) &&
        entry.relation_id === deriveRelationId(entry) &&
        entry.source.startsWith(`decision/${String(id)}/`) &&
        anchored.has(entry.source.slice(entry.source.lastIndexOf("/") + 1)),
    ),
    "every relation must derive its own relation_id and anchor on a chosen, rejected, or claim id of this decision",
  );
  check(
    new Set(relationIds).size === relationIds.length,
    "relation ids must be unique",
  );
  return issues;
}

export function validDecisionMutation(
  value: Readonly<Record<string, unknown>>,
  id: unknown,
  proposed: boolean,
  allowUnknownFields: boolean,
): boolean {
  const base = value.baseDocumentSha256;
  if (
    proposed
      ? base !== null
      : typeof base !== "string" || !/^[0-9a-f]{64}$/u.test(base)
  )
    return false;
  const claim = value.decisionDocumentClaim;
  if (
    !isRecord(claim) ||
    !matchesFields(
      claim,
      ["path", "sha256", "size", "mediaType", "policyId"],
      allowUnknownFields,
    ) ||
    claim.path !== `decisions/decision-${String(id)}/decision.md` ||
    !/^[0-9a-f]{64}$/u.test(String(claim.sha256)) ||
    !Number.isSafeInteger(claim.size) ||
    (claim.size as number) < 0 ||
    claim.mediaType !== "text/markdown" ||
    claim.policyId !== DECISION_DOCUMENT_POLICY_ID
  )
    return false;
  try {
    return normalizeRelativeDocumentPath(String(claim.path)) === claim.path;
  } catch {
    return false;
  }
}

export function sessionProvenanceValue(
  value: unknown,
  allowUnknownFields: boolean,
): boolean {
  if (validateSessionProvenance(value)) return timestamp(value.boundAt);
  if (!allowUnknownFields || !isRecord(value)) return false;
  return (
    validateSessionIdentity({
      runtime: value.runtime,
      sessionId: value.sessionId,
      transcriptReachability: value.transcriptReachability,
    }) && timestamp(value.boundAt)
  );
}

export function judgmentConsent(
  value: unknown,
  event: Readonly<Record<string, unknown>>,
  type: DecisionOutcomeType,
  allowUnknownFields: boolean,
): value is DecisionJudgmentConsentV1 {
  if (
    !isRecord(value) ||
    !matchesFields(
      value,
      [
        "schema",
        "consentId",
        "decisionId",
        "action",
        "targetState",
        "machineDigest",
        "actor",
        "source",
        "consentedAt",
      ],
      allowUnknownFields,
    )
  )
    return false;
  const action = type.slice("decision_".length, -2),
    targetState = outcomeState(type);
  return (
    value.schema === "decision-judgment-consent/v1" &&
    /^djc_[0-9a-f]{26}$/u.test(String(value.consentId)) &&
    value.decisionId === event.decisionId &&
    value.action === action &&
    value.targetState === targetState &&
    /^sha256:[0-9a-f]{64}$/u.test(String(value.machineDigest)) &&
    validateActorIdentity(value.actor, allowUnknownFields).length === 0 &&
    sameActorIdentity(value.actor, event.actor) &&
    validateWriteSource(value.source, allowUnknownFields).length === 0 &&
    sameWriteSource(value.source, event.source) &&
    value.consentedAt === event.occurredAt
  );
}

export function contentPin(
  value: unknown,
  event: Readonly<Record<string, unknown>>,
  allowUnknownFields: boolean,
): value is DecisionContentPinV1 {
  return (
    isRecord(value) &&
    matchesFields(
      value,
      [
        "schema",
        "pinId",
        "action",
        "state",
        "pinnedAt",
        "evidence",
        "actor",
        "digest",
      ],
      allowUnknownFields,
    ) &&
    value.schema === "decision-content-pin/v1" &&
    /^dcp_[0-9a-f]{26}$/u.test(String(value.pinId)) &&
    includes(
      [
        "accept",
        "reject",
        "defer",
        "supersede",
        "retire",
        "amend",
        "repin",
      ] as const,
      value.action,
    ) &&
    includes(decisionStates, value.state) &&
    value.pinnedAt === event.occurredAt &&
    codePoints(value.evidence, 1, 199) &&
    validateActorIdentity(value.actor, allowUnknownFields).length === 0 &&
    sameActorIdentity(value.actor, event.actor) &&
    /^sha256:[0-9a-f]{64}$/u.test(String(value.digest))
  );
}

export function amendment(
  value: unknown,
  event: Readonly<Record<string, unknown>>,
  allowUnknownFields: boolean,
): value is DecisionAmendmentV1 {
  return (
    isRecord(value) &&
    matchesFields(
      value,
      ["schema", "amendmentId", "fields", "actor", "amendedAt"],
      allowUnknownFields,
    ) &&
    value.schema === "decision-amendment/v1" &&
    /^dam_[0-9a-f]{26}$/u.test(String(value.amendmentId)) &&
    uniqueFactStrings(value.fields) &&
    value.fields.length > 0 &&
    validateActorIdentity(value.actor, allowUnknownFields).length === 0 &&
    sameActorIdentity(value.actor, event.actor) &&
    value.amendedAt === event.occurredAt
  );
}

export function amendableSnapshot(
  value: unknown,
  allowUnknownFields: boolean,
): value is DecisionAmendableSnapshot {
  if (
    !isRecord(value) ||
    !matchesFields(
      value,
      ["title", "decisionClass", "chosen", "rejected", "claims"],
      allowUnknownFields,
    ) ||
    !isNonEmptyString(value.title) ||
    !includes(["ordinary", "standing_policy"] as const, value.decisionClass) ||
    !Array.isArray(value.chosen) ||
    !Array.isArray(value.rejected) ||
    !Array.isArray(value.claims)
  )
    return false;
  const chosen = value.chosen.every(
      (entry) =>
        isRecord(entry) &&
        requiredWithOptional(
          entry,
          ["id", "text"],
          ["rationale"],
          allowUnknownFields,
        ) &&
        optionId(entry.id, "CH") &&
        isNonEmptyString(entry.text),
    ),
    rejected = value.rejected.every(
      (entry) =>
        isRecord(entry) &&
        matchesFields(entry, ["id", "text", "whyNot"], allowUnknownFields) &&
        optionId(entry.id, "RJ") &&
        isNonEmptyString(entry.text) &&
        isNonEmptyString(entry.whyNot),
    ),
    claims = value.claims.every(
      (entry) =>
        isRecord(entry) &&
        matchesFields(
          entry,
          ["id", "text", "loadBearing", "fulfillment"],
          allowUnknownFields,
        ) &&
        claimId(entry.id) &&
        isNonEmptyString(entry.text) &&
        typeof entry.loadBearing === "boolean" &&
        (entry.fulfillment === null ||
          includes(decisionFulfillmentModes, entry.fulfillment)),
    ),
    ids = [...value.chosen, ...value.rejected, ...value.claims].map((entry) =>
      isRecord(entry) ? entry.id : null,
    );
  return chosen && rejected && claims && new Set(ids).size === ids.length;
}

export function fulfillments(
  value: unknown,
  allowUnknownFields: boolean,
): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        matchesFields(entry, ["claimId", "mode"], allowUnknownFields) &&
        claimId(entry.claimId) &&
        includes(decisionFulfillmentModes, entry.mode),
    ) &&
    new Set(value.map((entry) => (isRecord(entry) ? entry.claimId : null)))
      .size === value.length
  );
}

export function relationId(value: unknown): value is string {
  return typeof value === "string" && /^rel_[0-9a-f]{16}$/u.test(value);
}

export function relation(
  value: unknown,
  allowUnknownFields: boolean,
): value is EntityRelationRecord {
  return (
    isRecord(value) &&
    matchesFields(
      value,
      [
        "relation_id",
        "source",
        "target",
        "type",
        "strength",
        "direction",
        "origin",
        "rationale",
        "state",
      ],
      allowUnknownFields,
    ) &&
    typeof value.relation_id === "string" &&
    /^rel_[0-9a-f]{16}$/u.test(value.relation_id) &&
    isNonEmptyString(value.source) &&
    isNonEmptyString(value.target) &&
    includes(relationTypes, value.type) &&
    includes(relationStrengths, value.strength) &&
    includes(relationDirections, value.direction) &&
    includes(relationOrigins, value.origin) &&
    codePoints(value.rationale, 1, 199) &&
    includes(relationStates, value.state) &&
    value.state === "active"
  );
}
