import { isNativeCommitSha, submissionDigest, type SubmissionDigest } from "./submission-digest.ts";
import type { ExecutionV1, ProjectedExecution } from "./execution.ts";
import { digest } from "./digest.ts";
import { hasOnlyFields, isNonEmptyString, isRecord, validateActorAxes } from "./task.ts";
import type { ActorAxes, ContractValidationIssue } from "./task.ts";
import type { WriteSource } from "./write-chain.contract.ts";
import { hasRequiredFields, validateWriteSource } from "./write-chain.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { timestamp } from "./timestamp.ts";
import { reviewConsentConflicts } from "./review-consent-validity.ts";
export const reviewFindingCategories = [
  "correctness",
  "completeness",
  "ci-required",
  "migration",
  "decision-break",
  "security-auth",
  "data-loss",
  "style",
  "diagnostic",
  "cleanup",
] as const;
export type ReviewFindingCategory = (typeof reviewFindingCategories)[number];
export const reviewFindingLabels = ["Important", "Nit", "Pre-existing"] as const;
export type ReviewFindingLabel = (typeof reviewFindingLabels)[number];
/** Historical owner ruling vocabulary retained only so admitted events remain readable. */
export const reviewFindingDispositions = ["blocker", "non_blocking", "nit", "pre_existing", "false_positive"] as const;
export type ReviewFindingDisposition = (typeof reviewFindingDispositions)[number];
export const reviewVerdicts = ["approved", "changes_requested", "dismissed"] as const;
export type ReviewVerdict = (typeof reviewVerdicts)[number];
export type ReviewResponseDisposition = "adopt" | "rebut";
export const REVIEW_FINDING_V1_OPTIONAL_FIELD_CONTRACTS = Object.freeze({
  anchor: { kind: "non-empty-string" },
  category: { kind: "enum", values: reviewFindingCategories },
  label: { kind: "enum", values: reviewFindingLabels },
  evidenceDigest: { kind: "sha256-digest", pattern: /^sha256:[0-9a-f]{64}$/u },
  priorFindingRefs: { kind: "non-empty-string-array", minItems: 1 },
} as const);

type ReviewFindingOptionalFieldContract =
  (typeof REVIEW_FINDING_V1_OPTIONAL_FIELD_CONTRACTS)[keyof typeof REVIEW_FINDING_V1_OPTIONAL_FIELD_CONTRACTS];
type ReviewFindingOptionalFieldValue<Contract> = Contract extends { kind: "non-empty-string" }
  ? string
  : Contract extends { kind: "enum"; values: readonly (infer Value extends string)[] }
    ? Value
    : Contract extends { kind: "sha256-digest" }
      ? `sha256:${string}`
      : Contract extends { kind: "non-empty-string-array" }
        ? readonly string[]
        : never;

export type ReviewFindingV1 = {
  readonly findingId: string;
  readonly blocking: boolean;
  readonly text: string;
} & {
  readonly [Field in keyof typeof REVIEW_FINDING_V1_OPTIONAL_FIELD_CONTRACTS]?: ReviewFindingOptionalFieldValue<
    (typeof REVIEW_FINDING_V1_OPTIONAL_FIELD_CONTRACTS)[Field]
  >;
};
export interface ReviewResolutionV1 {
  readonly reviewId: string;
  readonly findingId: string;
  readonly resolution: "upheld" | "withdrawn";
}
export interface TaskReviewResponseV1 {
  readonly reviewId: string;
  readonly findingId: string;
  readonly disposition: ReviewResponseDisposition;
  readonly rationale: string;
  readonly actor: ActorAxes;
  readonly respondedAt: string;
}
export interface ReviewV1 {
  readonly schema: "review/v1";
  readonly reviewId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly verdict: ReviewVerdict;
  readonly actor: ActorAxes;
  readonly capabilityRef: string;
  readonly reason: string;
  readonly evidenceChecked: readonly string[];
  readonly commitSha: string | null;
  readonly iteration: number;
  readonly contentDigest: `sha256:${string}`;
  readonly submissionDigest: SubmissionDigest;
  readonly reviewedAt: string;
  /** These arrays are absent only on historical records. New records always write both. */
  readonly findings?: readonly ReviewFindingV1[];
  readonly resolutions?: readonly ReviewResolutionV1[];
}
export interface ReviewConsentV1 {
  readonly schema: "review-consent/v1";
  readonly consentId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly reviewId: string;
  readonly reviewDigest: `sha256:${string}`;
  readonly contentDigest: `sha256:${string}`;
  readonly submissionDigest?: SubmissionDigest;
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly consentedAt: string;
}
export interface ReviewDispositionV1 {
  readonly schema: "review-disposition/v1";
  readonly dispositionId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly iteration: number;
  readonly submissionDigest: SubmissionDigest;
  readonly disposedReviewIds: readonly string[];
  readonly rationale: string;
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly disposedAt: string;
  /** Historical per-finding ruling; current consent writes no longer produce this field. */
  readonly findingRuling?: ReviewFindingRulingV1;
}
export interface ReviewFindingRulingV1 {
  readonly targetDigest: SubmissionDigest;
  readonly reviewId: string;
  readonly findingId: string;
  readonly disposition: ReviewFindingDisposition;
  readonly rationale: string;
}
export function validateReviewDispositionV1(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  const requiredFields = [
    "schema",
    "dispositionId",
    "taskId",
    "executionId",
    "iteration",
    "submissionDigest",
    "disposedReviewIds",
    "rationale",
    "actor",
    "source",
    "disposedAt",
  ] as const;
  const fields = [...requiredFields, "findingRuling"] as const;
  if (
    !isRecord(value) ||
    !(allowUnknownFields
      ? hasRequiredFields(value, requiredFields)
      : hasRequiredFields(value, requiredFields) &&
        Object.keys(value).every((field) => fields.includes(field as never)))
  )
    return [invalidReviewIssue("ReviewDisposition/v1 fields are incomplete or unknown")];
  const valid =
    value.schema === "review-disposition/v1" &&
    [value.dispositionId, value.taskId, value.executionId, value.rationale].every(isNonEmptyString) &&
    Number.isSafeInteger(value.iteration) &&
    Number(value.iteration) >= 0 &&
    digest(value.submissionDigest) &&
    Array.isArray(value.disposedReviewIds) &&
    (value.disposedReviewIds.length > 0 || value.findingRuling !== undefined) &&
    new Set(value.disposedReviewIds).size === value.disposedReviewIds.length &&
    value.disposedReviewIds.every(isNonEmptyString) &&
    timestamp(value.disposedAt) &&
    validateActorAxes(value.actor, allowUnknownFields).length === 0 &&
    validateWriteSource(value.source, allowUnknownFields).length === 0 &&
    (value.findingRuling === undefined || value.disposedReviewIds.length === 0) &&
    (value.findingRuling === undefined || validReviewFindingRuling(value.findingRuling, allowUnknownFields));
  return valid
    ? []
    : [invalidReviewIssue("review disposition must bind named reviews, rationale, content cut, actor, and source")];
}
function validReviewFindingRuling(value: unknown, allowUnknownFields: boolean): boolean {
  if (!isRecord(value)) return false;
  const fields = ["targetDigest", "reviewId", "findingId", "disposition", "rationale"] as const;
  return (
    (allowUnknownFields ? hasRequiredFields(value, fields) : hasOnlyFields(value, fields)) &&
    digest(value.targetDigest) &&
    [value.reviewId, value.findingId, value.rationale].every(isNonEmptyString) &&
    reviewFindingDispositions.includes(value.disposition as ReviewFindingDisposition)
  );
}
export interface ConsentedApprovedReview {
  readonly review: ReviewV1;
  readonly consent: ReviewConsentV1;
}
export const REVIEW_V1_SCHEMA = Object.freeze({
  id: "Review/v1",
  required: Object.freeze([
    "schema",
    "reviewId",
    "taskId",
    "executionId",
    "verdict",
    "actor",
    "capabilityRef",
    "reason",
    "evidenceChecked",
    "commitSha",
    "iteration",
    "contentDigest",
    "submissionDigest",
    "reviewedAt",
    "findings",
    "resolutions",
  ]),
  verdicts: reviewVerdicts,
  inputRequired: Object.freeze(["verdict", "reason", "evidenceChecked"] as const),
});
/** Fields a Review record had to carry before submissionDigest, findings, and resolutions were durable. */
export const REVIEW_V1_HISTORICAL_REQUIRED_FIELDS = Object.freeze(
  REVIEW_V1_SCHEMA.required.filter(
    (field) => field !== "submissionDigest" && field !== "findings" && field !== "resolutions",
  ),
);
export const REVIEW_CONSENT_V1_SCHEMA = Object.freeze({
  id: "ReviewConsent/v1",
  required: Object.freeze([
    "schema",
    "consentId",
    "taskId",
    "executionId",
    "reviewId",
    "reviewDigest",
    "contentDigest",
    "submissionDigest",
    "actor",
    "source",
    "consentedAt",
  ]),
});
/**
 * Shape check for a Review copy an event embeds instead of writing. A consent event carries the Review
 * the ledger already admitted, so it is validated at that recording boundary's shape — the same field
 * set `review_recorded` required when it accepted the record — never at the current new-record shape.
 */
export function validateAdmittedReviewV1(value: unknown): readonly ContractValidationIssue[] {
  return validateReviewV1(value, true);
}
export function validateReviewV1(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  const historicalFields = REVIEW_V1_HISTORICAL_REQUIRED_FIELDS,
    allowedFields = REVIEW_V1_SCHEMA.required;
  if (
    !isRecord(value) ||
    !(allowUnknownFields
      ? hasRequiredFields(value, historicalFields)
      : hasRequiredFields(value, allowedFields) && Object.keys(value).every((field) => allowedFields.includes(field)))
  )
    return [invalidReviewIssue("Review/v1 fields are incomplete or unknown")];
  const issues: ContractValidationIssue[] = [];
  if (
    value.schema !== "review/v1" ||
    !isNonEmptyString(value.reviewId) ||
    !isNonEmptyString(value.taskId) ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.capabilityRef) ||
    !isNonEmptyString(value.reason) ||
    !timestamp(value.reviewedAt) ||
    !reviewVerdicts.includes(value.verdict as ReviewVerdict)
  )
    issues.push(invalidReviewIssue("review identity, verdict, and reason are required"));
  if (
    !Array.isArray(value.evidenceChecked) ||
    value.evidenceChecked.some((item) => !isNonEmptyString(item)) ||
    (value.commitSha === null ? !digest(value.submissionDigest) : !isNativeCommitSha(value.commitSha)) ||
    !Number.isSafeInteger(value.iteration) ||
    Number(value.iteration) < 0 ||
    !digest(value.contentDigest) ||
    (value.submissionDigest !== undefined && !digest(value.submissionDigest))
  )
    issues.push(invalidReviewIssue("review content cut, evidence, commit, or iteration is invalid"));
  if (value.findings !== undefined) issues.push(...validateReviewFindings(value.findings, allowUnknownFields));
  if (value.resolutions !== undefined) issues.push(...validateReviewResolutions(value.resolutions, allowUnknownFields));
  issues.push(...validateActorAxes(value.actor, allowUnknownFields));
  return issues;
}

export function validateReviewFindings(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  if (!Array.isArray(value)) return [invalidReviewIssue("review findings must be an array")];
  const issues: ContractValidationIssue[] = [];
  const seen = new Set<string>();
  const optionalFields = Object.keys(REVIEW_FINDING_V1_OPTIONAL_FIELD_CONTRACTS),
    allowedFields = new Set(["findingId", "blocking", "text", ...optionalFields]);
  for (const finding of value) {
    const fields = ["findingId", "blocking", "text"] as const;
    if (
      !isRecord(finding) ||
      !hasRequiredFields(finding, fields) ||
      (!allowUnknownFields && Object.keys(finding).some((field) => !allowedFields.has(field)))
    ) {
      issues.push(invalidReviewIssue("review finding fields are incomplete or unknown"));
      continue;
    }
    if (
      !isNonEmptyString(finding.findingId) ||
      seen.has(finding.findingId) ||
      typeof finding.blocking !== "boolean" ||
      !isNonEmptyString(finding.text) ||
      (finding.anchor !== undefined && !isNonEmptyString(finding.anchor))
    )
      issues.push(invalidReviewIssue("review findings require unique ids, blocking flags, and text"));
    else seen.add(finding.findingId);
    const hasInvalidOptionalField = optionalFields.some((field) => {
      const fieldValue = finding[field];
      return (
        fieldValue !== undefined &&
        !isValidReviewFindingOptionalFieldValue(
          REVIEW_FINDING_V1_OPTIONAL_FIELD_CONTRACTS[field as keyof typeof REVIEW_FINDING_V1_OPTIONAL_FIELD_CONTRACTS],
          fieldValue,
        )
      );
    });
    if (hasInvalidOptionalField)
      issues.push(
        invalidReviewIssue(
          "review finding category, label, evidence digest, or prior finding refs are invalid when present",
        ),
      );
  }
  return issues;
}

function isValidReviewFindingOptionalFieldValue(contract: ReviewFindingOptionalFieldContract, value: unknown): boolean {
  switch (contract.kind) {
    case "non-empty-string":
      return isNonEmptyString(value);
    case "enum":
      return typeof value === "string" && (contract.values as readonly string[]).includes(value);
    case "sha256-digest":
      return typeof value === "string" && contract.pattern.test(value);
    case "non-empty-string-array":
      return (
        Array.isArray(value) &&
        value.length >= contract.minItems &&
        value.every((reference) => isNonEmptyString(reference))
      );
  }
}

export function validateReviewResolutions(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  if (!Array.isArray(value)) return [invalidReviewIssue("review resolutions must be an array")];
  const issues: ContractValidationIssue[] = [];
  for (const resolution of value) {
    const fields = ["reviewId", "findingId", "resolution"] as const;
    if (!isRecord(resolution) || !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(resolution, fields)) {
      issues.push(invalidReviewIssue("review resolution fields are incomplete or unknown"));
      continue;
    }
    if (
      !isNonEmptyString(resolution.reviewId) ||
      !isNonEmptyString(resolution.findingId) ||
      !["upheld", "withdrawn"].includes(String(resolution.resolution))
    )
      issues.push(invalidReviewIssue("review resolutions require review/finding ids and a valid resolution"));
  }
  return issues;
}

export function validateTaskReviewResponseV1(
  value: unknown,
  allowUnknownFields = false,
  includeAuthority = true,
): readonly ContractValidationIssue[] {
  const fields = ["reviewId", "findingId", "disposition", "rationale", "actor", "respondedAt"] as const;
  if (!isRecord(value) || !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, fields))
    return [invalidReviewIssue("task review response fields are incomplete or unknown")];
  const valid =
    [value.reviewId, value.findingId, value.rationale].every(isNonEmptyString) &&
    ["adopt", "rebut"].includes(String(value.disposition)) &&
    (!includeAuthority ||
      (timestamp(value.respondedAt) && validateActorAxes(value.actor, allowUnknownFields).length === 0));
  return valid ? [] : [invalidReviewIssue("task review response must name a finding and disposition rationale")];
}
export function validateReviewConsentV1(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  const historicalFields = REVIEW_CONSENT_V1_SCHEMA.required.filter((field) => field !== "submissionDigest");
  if (
    !isRecord(value) ||
    !(allowUnknownFields
      ? hasRequiredFields(value, historicalFields)
      : hasOnlyFields(value, REVIEW_CONSENT_V1_SCHEMA.required))
  )
    return [invalidReviewIssue("ReviewConsent/v1 fields are incomplete or unknown")];
  const valid =
    value.schema === "review-consent/v1" &&
    [value.consentId, value.taskId, value.executionId, value.reviewId].every(isNonEmptyString) &&
    timestamp(value.consentedAt) &&
    digest(value.reviewDigest) &&
    digest(value.contentDigest) &&
    (value.submissionDigest === undefined || digest(value.submissionDigest)) &&
    validateActorAxes(value.actor, allowUnknownFields).length === 0 &&
    validateWriteSource(value.source, allowUnknownFields).length === 0;
  return valid ? [] : [invalidReviewIssue("consent must bind review/content digests, execution, actor, and source")];
}
export function approvedReviewHistoryForExecution(
  reviews: readonly ReviewV1[],
  execution: ExecutionV1,
): readonly ReviewV1[] {
  return reviewsForExecution(reviews, execution).filter((review) => review.verdict === "approved");
}

export function reviewsForExecution(reviews: readonly ReviewV1[], execution: ExecutionV1): readonly ReviewV1[] {
  if (!execution.submission || !execution.submittedAt) return [];
  const pinned = submissionDigest(execution.submission),
    submittedAt = Date.parse(execution.submittedAt);
  return reviews.filter(
    (review) =>
      review.executionId === execution.executionId &&
      review.iteration === execution.iteration &&
      review.commitSha === execution.submission?.commitSha &&
      Date.parse(review.reviewedAt) >= submittedAt &&
      (review.submissionDigest === undefined || review.submissionDigest === pinned),
  );
}

export function consentedApprovedReviewForExecution(
  reviews: readonly ReviewV1[],
  consents: readonly ReviewConsentV1[],
  execution: ProjectedExecution,
  dispositions: readonly ReviewDispositionV1[] = [],
): ConsentedApprovedReview | undefined {
  if (execution.schema !== "execution/v1" || !execution.submission || !execution.submittedAt) return undefined;
  const currentReviews = reviewsForExecution(reviews, execution),
    currentSubmissionDigest = submissionDigest(execution.submission),
    submittedAt = Date.parse(execution.submittedAt);
  for (let index = consents.length - 1; index >= 0; index -= 1) {
    const consent = consents[index]!;
    if (consent.executionId !== execution.executionId || Date.parse(consent.consentedAt) < submittedAt) continue;
    const review = currentReviews.find((value) => value.reviewId === consent.reviewId);
    if (
      review &&
      reviewConsentConflicts({
        selectedReview: review,
        allowSelectedChangesRequested: true,
        reviews: currentReviews,
        dispositions,
        currentSubmissionDigest,
      }).length === 0 &&
      (consent.submissionDigest === currentSubmissionDigest || consent.submissionDigest === undefined) &&
      consent.reviewDigest === reviewDigest(review) &&
      consent.contentDigest === review.contentDigest
    )
      return { review, consent };
  }
  return undefined;
}
export function reviewDigest(review: ReviewV1): `sha256:${string}` {
  return `sha256:${sha256Text(stableStringify(review))}`;
}

function invalidReviewIssue(message: string): ContractValidationIssue {
  return { code: "invalid_review", message };
}
